"""옵션 2b reproducing E2E — captain 의 cross-module derived 모델 케이스.

captain 의 graph-only 모델 중 일부:
    db.AppUser(User)         module=zuzu.db.models.user.app_user
    db.Captable(Company)     module=zuzu.db.models.captable
    db.DirectorTerm(DirectorAppointmentEvent) module=zuzu.db.models...director_term

이들의 베이스(`User`, `Company`, `DirectorAppointmentEvent`)는 'Model' suffix 가
없으므로 1-pass 휴리스틱은 인식 못 함. 다행히 `_expand_model_candidates_via_imports`
가 이미 import 체인을 BFS 로 따라가서 알려진 candidate 의 자식을 추가 등록함.

이 E2E 는 옵션 2a (AbstractUser 화이트리스트) 가 적용된 상태에서 옵션 2b 의
2-pass expand 가 다단계 inheritance chain 을 정상적으로 catch up 하는지 검증:

    AbstractUser(Django)
        └─ User(AbstractUser)              ← 옵션 2a 로 1-pass 에서 잡힘
            └─ AppUser(User)               ← 2-pass expand 로 잡혀야 함

실행:
    PYTHONPATH=python python3 -m unittest python.tests.test_cross_module_derived_models -v
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from django_orm_intellisense.static_index.indexer import build_static_index


def _write_module(workspace: Path, dotted: str, source: str) -> None:
    parts = dotted.split('.')
    file_path = workspace.joinpath(*parts).with_suffix('.py')
    file_path.parent.mkdir(parents=True, exist_ok=True)
    # 같은 디렉토리에 __init__.py 가 없으면 module_name 산출이 깨질 수 있어 채워둠.
    for i in range(1, len(parts)):
        init_path = workspace.joinpath(*parts[:i]) / '__init__.py'
        if not init_path.exists():
            init_path.parent.mkdir(parents=True, exist_ok=True)
            init_path.write_text('')
    file_path.write_text(source)


class CaptainCrossModuleDerivedModelTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp_ctx = tempfile.TemporaryDirectory()
        self._workspace = Path(self._tmp_ctx.name)

    def tearDown(self) -> None:
        self._tmp_ctx.cleanup()

    def _candidates_by_object_name(self) -> dict[str, list[str]]:
        index = build_static_index(self._workspace)
        result: dict[str, list[str]] = {}
        for candidate in index.model_candidates:
            result.setdefault(candidate.object_name, []).append(candidate.module)
        return result

    def test_user_abstractuser_chain_resolves_appuser(self) -> None:
        """captain 핵심 체인: AbstractUser → User → AppUser.

        - 1-pass: `class User(AbstractUser):` 는 옵션 2a 화이트리스트로 잡힘
        - 2-pass: `class AppUser(User):` 는 expand 가 `User` import 를 따라가서 잡음
        """
        _write_module(
            self._workspace, 'zuzu.db.models.user.user',
            'from django.contrib.auth.models import AbstractUser\n'
            'class User(AbstractUser):\n'
            '    pass\n'
        )
        _write_module(
            self._workspace, 'zuzu.db.models.user.app_user',
            'from zuzu.db.models.user.user import User\n'
            'class AppUser(User):\n'
            '    pass\n'
        )

        names = self._candidates_by_object_name()
        self.assertIn(
            'User', names,
            f'옵션 2a 검증: User(AbstractUser) 는 candidate 가 되어야 함. '
            f'현재 candidates: {sorted(names)}',
        )
        self.assertIn(
            'AppUser', names,
            f'옵션 2b 검증: AppUser(User) 가 expand 단계에서 catch up 되어야 함. '
            f'현재 candidates: {sorted(names)}',
        )

    def test_company_captable_chain_via_workspace_internal_base(self) -> None:
        """captain 의 `class Captable(Company):` — workspace 내 concrete 모델
        상속. Company 가 옵션 2a 화이트리스트 + 다중 abstract base 휴리스틱으로
        잡히고, 그 자식 Captable 이 expand 로 잡혀야 함.
        """
        _write_module(
            self._workspace, 'zuzu.common.models.timestamped',
            'from django.db import models\n'
            'class TimestampedModel(models.Model):\n'
            '    class Meta:\n'
            '        abstract = True\n'
        )
        _write_module(
            self._workspace, 'zuzu.common.models.soft_deletable',
            'from django.db import models\n'
            'class SoftDeletableModel(models.Model):\n'
            '    class Meta:\n'
            '        abstract = True\n'
        )
        _write_module(
            self._workspace, 'zuzu.db.models.company.company',
            'from zuzu.common.models.timestamped import TimestampedModel\n'
            'from zuzu.common.models.soft_deletable import SoftDeletableModel\n'
            'class Company(TimestampedModel, SoftDeletableModel):\n'
            '    pass\n'
        )
        _write_module(
            self._workspace, 'zuzu.db.models.captable',
            'from zuzu.db.models.company.company import Company\n'
            'class Captable(Company):\n'
            '    pass\n'
        )

        names = self._candidates_by_object_name()
        self.assertIn('Company', names)
        self.assertIn(
            'Captable', names,
            f'옵션 2b: 워크스페이스 내 Company 를 상속한 Captable 이 candidate 로 '
            f'잡혀야 함. 현재 candidates: {sorted(names)}',
        )

    def test_captain_captable_via_explicit_reexport_init(self) -> None:
        """captain `zuzu.db.models.captable` 패턴 — `Captable(Company)` 가
        candidate=no 로 빠지는 진짜 원인 reproduce.

        captain의 `zuzu/db/models/company/__init__.py` 는:
            from .company import DELETION_DELAY, Company, PartnerType   # explicit, NOT star
        그리고 `zuzu/db/models/captable.py` 는:
            from zuzu.db.models.company import Company

        BFS 가 따라갈 import 체인:
          1. (zuzu.db.models.company.company, Company)   ← seed (Company candidate)
          2. (zuzu.db.models.company, Company)            ← init.py 의 explicit re-export
          3. (zuzu.db.models.captable, Company)            ← captable 의 import

        `_expand_model_candidates_via_imports.importers_of` 는 (1)→(2) 의
        reverse_imports 매핑은 out.extend 로 한 번에 수집하지만, (2) 를
        stack 에 push 하지 않음 — `star_re_exporters` 만 push 됨. 따라서 (2)
        에서 (3) 으로 점프하지 못함.
        """
        # __init__.py — explicit (non-star) re-export
        _write_module(
            self._workspace, 'zuzu.db.models.company.__init__',
            'from .company import Company\n'
        )
        _write_module(
            self._workspace, 'zuzu.db.models.company.company',
            'from django.db import models\n'
            'class Company(models.Model):\n'
            '    pass\n'
        )
        # captable — import via package, not submodule
        _write_module(
            self._workspace, 'zuzu.db.models.captable',
            'from zuzu.db.models.company import Company\n'
            'class Captable(Company):\n'
            '    pass\n'
        )

        names = self._candidates_by_object_name()
        self.assertIn('Company', names, 'seed candidate')
        self.assertIn(
            'Captable', names,
            f'captain regression: Captable(Company) via explicit re-export '
            f'init.py 가 expand BFS 에서 잡혀야 함. 현재 candidates: {sorted(names)}',
        )

    def test_multi_hop_event_chain_director_term(self) -> None:
        """captain 의 `DirectorTerm(DirectorAppointmentEvent)` — 3-단계 chain.

        EventModel(models.Model)
          └─ DirectorAppointmentEvent(EventModel)   ← 2-pass 로 잡혀야 함
              └─ DirectorTerm(DirectorAppointmentEvent) ← 3-pass 로 잡혀야 함
        """
        _write_module(
            self._workspace, 'zuzu.common.models.event',
            'from django.db import models\n'
            'class EventModel(models.Model):\n'
            '    class Meta:\n'
            '        abstract = True\n'
        )
        _write_module(
            self._workspace, 'zuzu.db.models.events.director_event',
            'from zuzu.common.models.event import EventModel\n'
            'class DirectorAppointmentEvent(EventModel):\n'
            '    pass\n'
        )
        _write_module(
            self._workspace, 'zuzu.db.models.stakeholder.director.director_term',
            'from zuzu.db.models.events.director_event import DirectorAppointmentEvent\n'
            'class DirectorTerm(DirectorAppointmentEvent):\n'
            '    pass\n'
        )

        names = self._candidates_by_object_name()
        self.assertIn('EventModel', names)
        self.assertIn(
            'DirectorAppointmentEvent', names,
            'EventModel 의 직계 자식이 잡혀야 다음 hop 으로 이어짐',
        )
        self.assertIn(
            'DirectorTerm', names,
            f'다단계 chain: DirectorTerm 까지 BFS 가 전파되어야 함. '
            f'현재 candidates: {sorted(names)}',
        )


if __name__ == '__main__':
    unittest.main()
