"""Whiteboards in MongoDB, database detective_whiteboard.

users {_id, name} and projects {_id, name, owner, members} prepare for logins and sharing; for now there is
one user with one project. app_state {_id: user, last_whiteboard} keeps each user's last opened whiteboard.
A whiteboard is one document in whiteboards {_id, project_id, name, version, chat}, and its cards and links
are documents in cards and links with its whiteboard_id, the ID the browser gave them and their order.
"""

import uuid

from pymongo import ASCENDING, MongoClient, ReplaceOne
from pymongo.errors import DuplicateKeyError

DATABASE = "detective_whiteboard"
DEFAULT_USER = "default-user"
DEFAULT_PROJECT = "Default"
FORBIDDEN = '/\\:*?"<>|'


class StorageError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class Storage:
    def __init__(self, client: MongoClient):
        self.client = client
        self.db = client[DATABASE]
        self.db.whiteboards.create_index([("project_id", ASCENDING), ("name", ASCENDING)], unique=True)
        for collection in (self.db.cards, self.db.links):
            collection.create_index([("whiteboard_id", ASCENDING), ("id", ASCENDING)], unique=True)
        self.db.links.create_index([("whiteboard_id", ASCENDING), ("source.card", ASCENDING)])
        self.db.links.create_index([("whiteboard_id", ASCENDING), ("target.card", ASCENDING)])
        self.db.users.update_one({"_id": DEFAULT_USER}, {"$setOnInsert": {"name": DEFAULT_USER}}, upsert=True)
        project = self.db.projects.find_one_and_update(
            {"owner": DEFAULT_USER, "name": DEFAULT_PROJECT},
            {"$setOnInsert": {"_id": new_id(), "members": []}},
            upsert=True,
            return_document=True,
        )
        self.default_project = project["_id"]

    # Until there are logins, every request comes from the default user working in its default project.
    def current_user(self) -> str:
        return DEFAULT_USER

    def current_project(self) -> str:
        return self.default_project

    def transaction(self, work):
        with self.client.start_session() as session:
            return session.with_transaction(lambda s: work(s))

    def whiteboard(self, name, session=None) -> dict:
        found = self.db.whiteboards.find_one({"project_id": self.current_project(), "name": check_name(name)}, session=session)
        if not found:
            raise StorageError(404, f'There is no whiteboard named "{name}".')
        return found

    def list(self) -> dict:
        boards = self.db.whiteboards.find({"project_id": self.current_project()}, {"name": 1})
        names = sorted((b["name"] for b in boards), key=str.lower)
        state = self.db.app_state.find_one({"_id": self.current_user()}) or {}
        last = self.db.whiteboards.find_one({"_id": state.get("last_whiteboard"), "project_id": self.current_project()})
        return {"boards": names, "last": last["name"] if last else None}

    def read(self, name) -> dict:
        board = self.whiteboard(name)
        hidden = {"_id": 0, "whiteboard_id": 0, "order": 0}
        return {
            "version": board.get("version", 1),
            "name": board["name"],
            "cards": list(self.db.cards.find({"whiteboard_id": board["_id"]}, hidden).sort("order")),
            "links": list(self.db.links.find({"whiteboard_id": board["_id"]}, hidden).sort("order")),
            "chat": board.get("chat", []),
        }

    def save(self, name, data: dict, create: bool) -> None:
        name = check_name(name)

        def work(session):
            existing = self.db.whiteboards.find_one({"project_id": self.current_project(), "name": name}, session=session)
            if existing and create:
                raise StorageError(409, f'A whiteboard named "{name}" already exists.')
            board_id = existing["_id"] if existing else new_id()
            fields = {"project_id": self.current_project(), "name": name, "version": data.get("version", 1), "chat": data.get("chat", [])}
            self.db.whiteboards.replace_one({"_id": board_id}, fields, upsert=True, session=session)
            for collection, items in ((self.db.cards, data.get("cards", [])), (self.db.links, data.get("links", []))):
                ids = [item["id"] for item in items]
                collection.delete_many({"whiteboard_id": board_id, "id": {"$nin": ids}}, session=session)
                if items:
                    collection.bulk_write(
                        [
                            ReplaceOne({"whiteboard_id": board_id, "id": item["id"]}, {**item, "whiteboard_id": board_id, "order": i}, upsert=True)
                            for i, item in enumerate(items)
                        ],
                        session=session,
                    )

        self.transaction(work)

    def rename(self, old, new) -> None:
        board = self.whiteboard(old)
        try:
            self.db.whiteboards.update_one({"_id": board["_id"]}, {"$set": {"name": check_name(new)}})
        except DuplicateKeyError:
            raise StorageError(409, f'A whiteboard named "{new}" already exists.')

    def delete(self, name) -> None:
        def work(session):
            board_id = self.whiteboard(name, session)["_id"]
            for collection in (self.db.cards, self.db.links):
                collection.delete_many({"whiteboard_id": board_id}, session=session)
            self.db.whiteboards.delete_one({"_id": board_id}, session=session)
            self.db.app_state.update_one(
                {"_id": self.current_user(), "last_whiteboard": board_id}, {"$unset": {"last_whiteboard": ""}}, session=session
            )

        self.transaction(work)

    def set_last(self, name) -> None:
        board_id = self.whiteboard(name)["_id"] if name else None
        self.db.app_state.update_one({"_id": self.current_user()}, {"$set": {"last_whiteboard": board_id}}, upsert=True)


def new_id() -> str:
    return uuid.uuid4().hex


def check_name(name) -> str:
    """The rules from when names were file names, kept because Export still uses the name as the file name."""
    if not isinstance(name, str) or not name.strip() or name != name.strip() or not name.isprintable() or set(name) & set(FORBIDDEN):
        raise StorageError(400, f"A whiteboard name must not be blank or contain any of: {' '.join(FORBIDDEN)}")
    return name
