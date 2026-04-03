from django.db import models


class BookQuerySet(models.QuerySet):
    def titled(self, text: str) -> 'BookQuerySet':
        return self.filter(title__icontains=text)


EXPORTED_QUERYSET = BookQuerySet

__all__ = ['BookQuerySet', 'EXPORTED_QUERYSET']
