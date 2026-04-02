from __future__ import annotations

import json
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..discovery.workspace import discover_workspace
from ..features.health import build_health_snapshot
from ..runtime.inspector import inspect_runtime
from ..semantic.graph import build_semantic_graph
from ..static_index.indexer import build_static_index


class DaemonServer:
    def __init__(self, workspace_root: Path):
        self.workspace_root = workspace_root
        self.initialized_at = datetime.now(timezone.utc)
        self.health_snapshot: dict[str, Any] | None = None

    def run_stdio(self) -> None:
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue

            try:
                request = json.loads(line)
            except json.JSONDecodeError as error:
                self._write_error(
                    request_id=None,
                    code='invalid_json',
                    message=str(error),
                    data={'raw': line},
                )
                continue

            self._handle_request(request)

    def _handle_request(self, request: dict[str, Any]) -> None:
        request_id = request.get('id')
        method = request.get('method')
        params = request.get('params') or {}

        try:
            if method == 'initialize':
                result = self._initialize(params)
            elif method == 'health':
                result = self._health()
            else:
                raise ValueError(f'Unsupported method: {method}')
        except Exception as error:  # pragma: no cover - scaffold safety net
            self._write_error(
                request_id=request_id,
                code='internal_error',
                message=str(error),
                data={'traceback': traceback.format_exc(limit=8)},
            )
            return

        self._write_response(request_id, result)

    def _initialize(self, params: dict[str, Any]) -> dict[str, Any]:
        workspace_root = Path(
            str(params.get('workspaceRoot') or self.workspace_root)
        ).resolve()
        settings_module = _clean_optional_string(params.get('settingsModule'))
        self.workspace_root = workspace_root
        self.initialized_at = datetime.now(timezone.utc)

        workspace_profile = discover_workspace(workspace_root, settings_module)
        static_index = build_static_index(workspace_root)
        runtime = inspect_runtime(settings_module or workspace_profile.settings_module)
        semantic_graph = build_semantic_graph(workspace_profile, static_index, runtime)
        self.health_snapshot = build_health_snapshot(
            workspace=workspace_profile,
            static_index=static_index,
            runtime=runtime,
            semantic_graph=semantic_graph,
            initialized_at=self.initialized_at,
        )

        return {
            'serverName': 'django-orm-intellisense',
            'protocolVersion': '0.1',
            'health': self.health_snapshot,
        }

    def _health(self) -> dict[str, Any]:
        if self.health_snapshot is None:
            return self._initialize({})

        return self.health_snapshot

    def _write_response(self, request_id: Any, result: Any) -> None:
        payload = {
            'id': request_id,
            'result': result,
        }
        sys.stdout.write(json.dumps(payload, sort_keys=True) + '\n')
        sys.stdout.flush()

    def _write_error(
        self,
        request_id: Any,
        code: str,
        message: str,
        data: dict[str, Any] | None = None,
    ) -> None:
        payload = {
            'id': request_id,
            'error': {
                'code': code,
                'message': message,
                'data': data or {},
            },
        }
        sys.stdout.write(json.dumps(payload, sort_keys=True) + '\n')
        sys.stdout.flush()


def _clean_optional_string(value: Any) -> str | None:
    if value is None:
        return None

    text = str(value).strip()
    return text or None
