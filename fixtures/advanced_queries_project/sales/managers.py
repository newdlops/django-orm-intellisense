from django.db import models


class ProductQuerySet(models.QuerySet):
    def active(self) -> 'ProductQuerySet':
        return self.filter(is_active=True)

    def with_line_count(self) -> 'ProductQuerySet':
        return self.annotate(line_count=models.Count('lines'))


class ProductManager(models.Manager.from_queryset(ProductQuerySet)):
    pass


class FulfillmentDetailQuerySet(models.QuerySet):
    def exclude_deleted(self) -> 'FulfillmentDetailQuerySet':
        return self.exclude(detail_code='deleted')


class FulfillmentDetailManager(
    models.Manager.from_queryset(FulfillmentDetailQuerySet)
):
    pass
