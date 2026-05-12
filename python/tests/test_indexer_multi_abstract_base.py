"""옵션 2 reproducing E2E — captain의 `candidate=no` 미스 패턴.

captain 로그(`log.txt:30`)에서 발견된 패턴:
    db.Company         module=zuzu.db.models.company.company         candidate=no
    db.User            module=zuzu.db.models.user.user               candidate=no
    db.AppUser         module=zuzu.db.models.user.app_user           candidate=no
vs
    db.CalendarEvent   module=...calendar_event.calendar_event       candidate=yes
    db.CompanyDepartment ...                                         candidate=yes

차이점: captain의 실제 소스를 확인해보면
  * `class CalendarEvent(TimestampedModel):`                ← 단일 abstract 베이스 → 인식 됨
  * `class Company(TimestampedModel, SoftDeletableModel):` ← 다중 abstract 베이스 → 인식 안 됨

인덱서 코드(`indexer.py:_looks_like_model_candidate`)는:
    return any(_is_model_base(base) for base in node.bases)

두 베이스 모두 'Model'로 끝나므로 `any(...)`는 True여야 함. 즉, AST 레벨에서는
candidate로 식별되어야 정상. captain에서 `candidate=no`가 나오는 건:

  (가설 A) 인덱서 캐시가 stale (옛 코드의 결과 보존)
  (가설 B) 인덱서가 다중 abstract 베이스 케이스에서 다른 경로로 빠짐
  (가설 C) `_model_candidate_from_class` 가 None 반환

이 E2E는 가설 B/C를 검증함 — 다중 abstract 베이스 패턴이 정상 동작하면 PASS,
실패하면 인덱서 자체 버그가 있다는 의미. 만약 PASS면 captain은 가설 A(캐시) 문제.

실행:
    PYTHONPATH=python python3 -m unittest python.tests.test_indexer_multi_abstract_base -v
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

from django_orm_intellisense.static_index.indexer import (
    _looks_like_model_candidate,
    _model_candidate_from_class,
)


# captain `zuzu/db/models/company/company.py` L242 의 클래스 헤더 그대로
CAPTAIN_COMPANY_SOURCE = """
from django.db import models

class Company(  # type: ignore[django-manager-missing]
    TimestampedModel,
    SoftDeletableModel,
):
    pass
"""

# captain `zuzu/db/models/calendar_event/calendar_event.py` 의 단일 abstract 베이스 패턴
CAPTAIN_CALENDAR_EVENT_SOURCE = """
from django.db import models
from zuzu.common.models.timestamped import TimestampedModel

class CalendarEvent(TimestampedModel):
    pass
"""

# captain `zuzu/db/models/user/user.py` 패턴 — Django AbstractUser 상속 (역시 candidate=no)
CAPTAIN_USER_SOURCE = """
from django.contrib.auth.models import AbstractUser

class User(AbstractUser):
    pass
"""

# captain `zuzu/db/models/user/app_user.py` 의 patten 추정 — User 상속한 proxy 모델
CAPTAIN_APP_USER_SOURCE = """
class AppUser(User):
    class Meta:
        proxy = True
"""


def _class_node_from_source(source: str) -> ast.ClassDef:
    tree = ast.parse(source)
    class_nodes = [n for n in tree.body if isinstance(n, ast.ClassDef)]
    assert len(class_nodes) == 1, f'expected 1 class, got {len(class_nodes)}'
    return class_nodes[0]


class CaptainCandidateNoPatternTest(unittest.TestCase):
    """captain의 `candidate=no` 미스 케이스들을 인덱서 레벨에서 reproduce."""

    def test_calendar_event_single_abstract_base_is_candidate(self) -> None:
        """대조군: 단일 abstract 베이스는 candidate=yes (captain에서도 yes)."""
        node = _class_node_from_source(CAPTAIN_CALENDAR_EVENT_SOURCE)
        self.assertTrue(
            _looks_like_model_candidate(node),
            'TimestampedModel 단일 상속은 model candidate로 인식되어야 함 '
            '(captain의 db.CalendarEvent 가 candidate=yes 인 이유).',
        )
        candidate = _model_candidate_from_class(
            python_file=Path('/captain/zuzu/db/models/calendar_event/calendar_event.py'),
            module_name='zuzu.db.models.calendar_event.calendar_event',
            node=node,
        )
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate.object_name, 'CalendarEvent')

    def test_company_multi_abstract_base_is_candidate(self) -> None:
        """캡틴 핵심 케이스: `class Company(TimestampedModel, SoftDeletableModel):`

        두 abstract 베이스 모두 'Model'로 끝나므로 `_looks_like_model_candidate`는
        True여야 함. 만약 이 테스트가 실패하면 인덱서 자체에 다중 abstract 베이스
        처리 버그가 있다는 강한 증거. 통과하면 captain의 `candidate=no`는 stale
        cache 문제일 가능성이 큼.
        """
        node = _class_node_from_source(CAPTAIN_COMPANY_SOURCE)
        self.assertTrue(
            _looks_like_model_candidate(node),
            'TimestampedModel + SoftDeletableModel 다중 abstract 베이스가 '
            '인식되지 않으면 captain의 db.Company는 영원히 graph-only로 빠짐.',
        )
        candidate = _model_candidate_from_class(
            python_file=Path('/captain/zuzu/db/models/company/company.py'),
            module_name='zuzu.db.models.company.company',
            node=node,
        )
        self.assertIsNotNone(
            candidate,
            f'_model_candidate_from_class 가 None을 반환함 — 다중 abstract '
            f'베이스 케이스에서 후속 처리가 막힘. 노드: {ast.dump(node)[:200]}',
        )
        self.assertEqual(candidate.object_name, 'Company')
        self.assertEqual(
            candidate.base_class_refs,
            ('TimestampedModel', 'SoftDeletableModel'),
            'base_class_refs 가 둘 다 추출되어야 cross-app 베이스 해석이 가능.',
        )
        # 옵션 C는 이 candidate가 만들어진 다음에야 의미가 있음. candidate가
        # 안 만들어지면 graph linker가 (module, object_name)으로 조회할 대상
        # 자체가 없어서 다리를 놓을 수 없음.
        self.assertFalse(
            candidate.is_abstract,
            'Company 는 concrete 모델 — Meta.abstract 가 없으니 abstract '
            'False여야 함.',
        )

    def test_user_django_abstract_user_base_is_candidate(self) -> None:
        """옵션 2a fix 검증: captain `db.User(AbstractUser)` 가 candidate=yes.

        Django auth 의 `AbstractUser` 는 'Model' suffix 가 없어서 옛 휴리스틱이
        놓쳤음. `_KNOWN_ABSTRACT_BASE_SUFFIXES` 화이트리스트로 보강 후 잡혀야 함.
        """
        node = _class_node_from_source(CAPTAIN_USER_SOURCE)
        self.assertTrue(
            _looks_like_model_candidate(node),
            '옵션 2a 후: AbstractUser 베이스가 화이트리스트로 인식되어야 함.',
        )
        candidate = _model_candidate_from_class(
            python_file=Path('/captain/zuzu/db/models/user/user.py'),
            module_name='zuzu.db.models.user.user',
            node=node,
        )
        self.assertIsNotNone(
            candidate,
            'captain db.User 의 ModelCandidate 가 만들어져야 옵션 C 의 '
            '(module, object_name) graph 다리가 db.User 를 surface 에 노출 가능.',
        )
        self.assertEqual(candidate.object_name, 'User')

    def test_app_user_concrete_proxy_inheriting_user_is_not_candidate(
        self,
    ) -> None:
        """captain `db.AppUser` 케이스: `class AppUser(User):` — User 자체가
        인덱서에 잡히지 않으면 AppUser 도 도미노로 잡히지 않음.

        `User`라는 베이스 이름은 'Model'/'BaseModel' 등 어떤 suffix에도 매칭
        안 됨. 즉 다단계 inheritance 체인이 인덱서 단일-패스 휴리스틱으로는
        해소되지 않는 구조적 한계.
        """
        node = _class_node_from_source(CAPTAIN_APP_USER_SOURCE)
        self.assertFalse(
            _looks_like_model_candidate(node),
            "베이스 이름 'User'는 'Model' suffix가 없어 candidate 미인식. "
            'captain의 db.AppUser 도 마찬가지 패턴.',
        )


if __name__ == '__main__':
    unittest.main()
