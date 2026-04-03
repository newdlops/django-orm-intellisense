from django.db import models


class ProductQuerySet(models.QuerySet):
    def active(self) -> 'ProductQuerySet':
        return self.filter(is_active=True)

    def with_line_count(self) -> 'ProductQuerySet':
        return self.annotate(line_count=models.Count('lines'))


class ProductManager(models.Manager.from_queryset(ProductQuerySet)):
    pass
