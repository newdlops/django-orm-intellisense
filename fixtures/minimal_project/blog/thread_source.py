"""Cross-module source for a custom QuerySet, mirroring the real-world
`hrm_emp_service.get_emps(hrm) -> HrmEmpQuerySet` helper that lives in a
different module from the call site and is imported function-locally."""

from blog.models import QuestionThread, QuestionThreadQuerySet


def get_threads() -> QuestionThreadQuerySet:
    return QuestionThread.objects.all()
