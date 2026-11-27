"""MongoDB in a Podman container that the app starts and stops.

The data lives in a host folder, so every start can use a fresh container (--rm). The database is a
single-node replica set, which MongoDB needs for transactions.
"""

import json
import subprocess
import time
from pathlib import Path

from pymongo import MongoClient
from pymongo.errors import OperationFailure, PyMongoError

IMAGE = "docker.io/library/mongo:8.0"
REPLICA_SET = "rs0"
START_TIMEOUT = 60


class ContainerError(Exception):
    pass


def podman(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(["podman", *args], capture_output=True, text=True, check=check)
    except FileNotFoundError:
        raise ContainerError("Podman is not installed; the app needs it to run MongoDB.")
    except subprocess.CalledProcessError as err:
        raise ContainerError(f"podman {args[0]} failed: {err.stderr.strip()}")


class MongoContainer:
    def __init__(self, data_dir: Path, port: int):
        self.data_dir = data_dir.resolve()
        self.port = port
        self.name = f"detective-whiteboard-mongo-{port}"
        self.owned = False  # whether stop() may stop the container: one this app started or reused

    def start(self) -> MongoClient:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        # A container left running, for example after a crash, is reused if it serves the same data folder.
        running = False
        found = podman("container", "inspect", self.name, check=False)
        if found.returncode == 0:
            info = json.loads(found.stdout)[0]
            sources = {Path(mount["Source"]) for mount in info["Mounts"]}
            if self.data_dir not in sources:
                raise ContainerError(
                    f"Container {self.name} uses another data folder ({', '.join(map(str, sources))}). "
                    f"Stop it with `podman stop {self.name}` or choose another --db-port."
                )
            running = info["State"]["Running"]
            self.owned = running
            if not running:
                podman("rm", "-f", self.name)
        if not running:
            print(f"Starting MongoDB ({IMAGE}; the first start downloads it)...", flush=True)
            podman(
                "run", "-d", "--rm", "--name", self.name,
                # keep-id runs mongod as the user, so the files in the data folder belong to the user.
                "--userns=keep-id", "--image-volume=ignore",
                "-p", f"127.0.0.1:{self.port}:27017",
                "-v", f"{self.data_dir}:/data/db:Z",
                IMAGE, "--replSet", REPLICA_SET, "--bind_ip_all",
            )
            self.owned = True
        url = f"mongodb://127.0.0.1:{self.port}/?directConnection=true"
        # A client that connected before the replica set was ready keeps thinking it has no sessions,
        # so the app gets a new one once the database is ready.
        with MongoClient(url, serverSelectionTimeoutMS=2000) as probe:
            self.wait(probe)
        return MongoClient(url)

    def wait(self, client: MongoClient) -> None:
        deadline = time.monotonic() + START_TIMEOUT
        initiated = False
        while True:
            try:
                if client.admin.command("hello").get("isWritablePrimary"):
                    return
                if not initiated:
                    client.admin.command("replSetInitiate", {"_id": REPLICA_SET, "members": [{"_id": 0, "host": "127.0.0.1:27017"}]})
                    initiated = True
            except OperationFailure as err:
                # Already initiated by an earlier start.
                if err.code != 23:
                    raise
                initiated = True
            except PyMongoError:
                pass
            if time.monotonic() > deadline:
                logs = podman("logs", "--tail", "20", self.name, check=False).stdout
                raise ContainerError(f"MongoDB did not start within {START_TIMEOUT} seconds.\n{logs}")
            time.sleep(0.5)

    def stop(self) -> None:
        if not self.owned:
            return
        print("Stopping MongoDB...", flush=True)
        podman("stop", "-t", "30", self.name, check=False)
