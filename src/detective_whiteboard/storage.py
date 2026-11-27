"""Projects and whiteboards in MongoDB, database detective_whiteboard.

users {_id, name}: for now only the default user, until there are logins.
projects {_id, name, owner, members}: a user sees the projects they own or are a member of.
app_state {_id: user, last_whiteboard}: each user's last opened whiteboard.
whiteboards {_id, project_id, name, version, chat}; its cards and links are documents in cards and links
with its whiteboard_id, the ID the browser gave them and their order.
"""

import uuid

from pymongo import ASCENDING, MongoClient, ReplaceOne
from pymongo.errors import DuplicateKeyError

DATABASE = "detective_whiteboard"
DEFAULT_USER = "default-user"
FORBIDDEN = '/\\:*?"<>|'


class StorageError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class Storage:
    def __init__(self, client: MongoClient):
        self.client = client
        self.db = client[DATABASE]
        self.db.projects.create_index([("owner", ASCENDING), ("name", ASCENDING)], unique=True)
        self.db.projects.create_index("members")
        self.db.whiteboards.create_index([("project_id", ASCENDING), ("name", ASCENDING)], unique=True)
        for collection in (self.db.cards, self.db.links):
            collection.create_index([("whiteboard_id", ASCENDING), ("id", ASCENDING)], unique=True)
        self.db.links.create_index([("whiteboard_id", ASCENDING), ("source.card", ASCENDING)])
        self.db.links.create_index([("whiteboard_id", ASCENDING), ("target.card", ASCENDING)])
        self.db.users.update_one({"_id": DEFAULT_USER}, {"$setOnInsert": {"name": DEFAULT_USER}}, upsert=True)

    # Until there are logins, every request comes from the default user.
    def current_user(self) -> str:
        return DEFAULT_USER

    def visible(self) -> dict:
        """The query for the projects the current user can open."""
        user = self.current_user()
        return {"$or": [{"owner": user}, {"members": user}]}

    def transaction(self, work):
        with self.client.start_session() as session:
            return session.with_transaction(work)

    def project(self, project_id, session=None) -> dict:
        found = self.db.projects.find_one({"_id": project_id, **self.visible()}, session=session)
        if not found:
            raise StorageError(404, "This project does not exist (any more).")
        return found

    def whiteboard(self, board_id, session=None) -> dict:
        found = self.db.whiteboards.find_one({"_id": board_id}, session=session)
        if not found:
            raise StorageError(404, "This whiteboard does not exist (any more).")
        self.project(found["project_id"], session)
        return found

    # ---------- Projects ----------

    def list(self) -> dict:
        """Every project of the user with its whiteboards, both sorted by name, and the last whiteboard."""
        projects = list(self.db.projects.find(self.visible(), {"name": 1}))
        boards = self.db.whiteboards.find({"project_id": {"$in": [p["_id"] for p in projects]}}, {"name": 1, "project_id": 1})
        by_project = {p["_id"]: [] for p in projects}
        for board in boards:
            by_project[board["project_id"]].append({"id": board["_id"], "name": board["name"]})
        by_name = lambda item: item["name"].lower()
        state = self.db.app_state.find_one({"_id": self.current_user()}) or {}
        last = self.db.whiteboards.find_one({"_id": state.get("last_whiteboard"), "project_id": {"$in": list(by_project)}})
        return {
            "projects": sorted(
                ({"id": p["_id"], "name": p["name"], "boards": sorted(by_project[p["_id"]], key=by_name)} for p in projects),
                key=by_name,
            ),
            "last": {"project": last["project_id"], "board": last["_id"]} if last else None,
        }

    def create_project(self, name) -> str:
        project_id = new_id()
        try:
            self.db.projects.insert_one({"_id": project_id, "name": check_name(name), "owner": self.current_user(), "members": []})
        except DuplicateKeyError:
            raise StorageError(409, f'A project named "{name}" already exists.')
        return project_id

    def rename_project(self, project_id, name) -> None:
        self.project(project_id)
        try:
            self.db.projects.update_one({"_id": project_id}, {"$set": {"name": check_name(name)}})
        except DuplicateKeyError:
            raise StorageError(409, f'A project named "{name}" already exists.')

    def delete_project(self, project_id) -> None:
        def work(session):
            self.project(project_id, session)
            board_ids = [b["_id"] for b in self.db.whiteboards.find({"project_id": project_id}, {"_id": 1}, session=session)]
            self.delete_contents(board_ids, session)
            self.db.projects.delete_one({"_id": project_id}, session=session)

        self.transaction(work)

    # ---------- Whiteboards ----------

    def read(self, board_id) -> dict:
        board = self.whiteboard(board_id)
        hidden = {"_id": 0, "whiteboard_id": 0, "order": 0}
        return {
            "version": board.get("version", 1),
            "name": board["name"],
            "cards": list(self.db.cards.find({"whiteboard_id": board_id}, hidden).sort("order")),
            "links": list(self.db.links.find({"whiteboard_id": board_id}, hidden).sort("order")),
            "chat": board.get("chat", []),
        }

    def create(self, project_id, data: dict, overwrite: bool) -> str:
        """A new whiteboard in the project from its JSON. With overwrite, one with the same name is replaced."""
        name = check_name(data.get("name"))

        def work(session):
            self.project(project_id, session)
            existing = self.db.whiteboards.find_one({"project_id": project_id, "name": name}, session=session)
            if existing and not overwrite:
                raise StorageError(409, f'A whiteboard named "{name}" already exists in this project.')
            board_id = existing["_id"] if existing else new_id()
            self.db.whiteboards.replace_one(
                {"_id": board_id}, {"project_id": project_id, "name": name, **contents(data)}, upsert=True, session=session
            )
            self.write_items(board_id, data, session)
            return board_id

        return self.transaction(work)

    def save(self, board_id, data: dict) -> None:
        """Replaces the cards, links and chat. The name changes only through rename."""

        def work(session):
            self.whiteboard(board_id, session)
            self.db.whiteboards.update_one({"_id": board_id}, {"$set": contents(data)}, session=session)
            self.write_items(board_id, data, session)

        self.transaction(work)

    def write_items(self, board_id, data: dict, session) -> None:
        for collection, items in ((self.db.cards, data.get("cards", [])), (self.db.links, data.get("links", []))):
            collection.delete_many({"whiteboard_id": board_id, "id": {"$nin": [item["id"] for item in items]}}, session=session)
            if items:
                collection.bulk_write(
                    [
                        ReplaceOne({"whiteboard_id": board_id, "id": item["id"]}, {**item, "whiteboard_id": board_id, "order": i}, upsert=True)
                        for i, item in enumerate(items)
                    ],
                    session=session,
                )

    def rename(self, board_id, name) -> None:
        self.whiteboard(board_id)
        try:
            self.db.whiteboards.update_one({"_id": board_id}, {"$set": {"name": check_name(name)}})
        except DuplicateKeyError:
            raise StorageError(409, f'A whiteboard named "{name}" already exists in this project.')

    def delete(self, board_id) -> None:
        def work(session):
            self.whiteboard(board_id, session)
            self.delete_contents([board_id], session)

        self.transaction(work)

    def delete_contents(self, board_ids: list, session) -> None:
        """Deletes whiteboards with their cards and links, and forgets them as anyone's last whiteboard."""
        query = {"whiteboard_id": {"$in": board_ids}}
        self.db.cards.delete_many(query, session=session)
        self.db.links.delete_many(query, session=session)
        self.db.whiteboards.delete_many({"_id": {"$in": board_ids}}, session=session)
        self.db.app_state.update_many({"last_whiteboard": {"$in": board_ids}}, {"$unset": {"last_whiteboard": ""}}, session=session)

    def set_last(self, board_id) -> None:
        if board_id:
            self.whiteboard(board_id)
        self.db.app_state.update_one({"_id": self.current_user()}, {"$set": {"last_whiteboard": board_id}}, upsert=True)


def contents(data: dict) -> dict:
    return {"version": data.get("version", 1), "chat": data.get("chat", [])}


def new_id() -> str:
    return uuid.uuid4().hex


def check_name(name) -> str:
    """Names of projects and whiteboards: Export uses a whiteboard's name as the file name."""
    if not isinstance(name, str) or not name.strip() or name != name.strip() or not name.isprintable() or set(name) & set(FORBIDDEN):
        raise StorageError(400, f"A name must not be blank or contain any of: {' '.join(FORBIDDEN)}")
    return name
