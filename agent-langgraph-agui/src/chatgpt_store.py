"""Keep a refreshed, bind-mounted ChatGPT store readable by its desktop owner."""

import os
from pathlib import Path
from tempfile import TemporaryDirectory

from langchain_openai.chatgpt_oauth import (
    _ChatGPTToken,
    _FileChatGPTOAuthTokenProvider,
)


class ChatGptTokenStore(_FileChatGPTOAuthTokenProvider):
    def _write_to_disk(self, token: _ChatGPTToken) -> None:
        if os.name != "posix":
            return super()._write_to_disk(token)
        try:
            owner = self.path.stat()
        except FileNotFoundError:
            return super()._write_to_disk(token)

        # The container can be root while the desktop owns the mounted 0600 file.
        # Read IDs inside this namespace: host IDs are different under rootless engines.
        # Keep the vendor's serialization and refresh locks; only publication changes.
        with TemporaryDirectory(prefix=".chatgpt-write-", dir=self.path.parent) as directory:
            staged = Path(directory) / self.path.name
            _FileChatGPTOAuthTokenProvider(path=staged)._write_to_disk(token)
            with staged.open("r+b") as file:
                os.fchown(file.fileno(), owner.st_uid, owner.st_gid)
                os.fchmod(file.fileno(), 0o600)
                os.fsync(file.fileno())
            # Ownership must be correct before the atomic replacement. A failed assignment
            # leaves the previous store intact, with no unreadable live-file interval.
            staged.replace(self.path)
