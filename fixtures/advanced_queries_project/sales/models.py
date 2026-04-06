from django.db import models

from .managers import FulfillmentDetailManager, ProductManager


class Product(models.Model):
    category = models.ForeignKey(
        'catalog.Category',
        related_name='products',
        on_delete=models.CASCADE,
    )
    name = models.CharField(max_length=128)
    is_active = models.BooleanField(default=True)

    objects = ProductManager()


class Order(models.Model):
    customer_name = models.CharField(max_length=128)
    created_at = models.DateTimeField(auto_now_add=True)


class LineItem(models.Model):
    order = models.ForeignKey(
        'sales.Order',
        related_name='lines',
        on_delete=models.CASCADE,
    )
    product = models.ForeignKey(
        Product,
        related_name='lines',
        on_delete=models.CASCADE,
    )
    quantity = models.PositiveIntegerField(default=1)


class Fulfillment(models.Model):
    reference = models.CharField(max_length=64)


class FulfillmentDetail(models.Model):
    detail_code = models.CharField(max_length=64)
    fulfillment = models.ForeignKey(
        Fulfillment,
        related_name='details',
        on_delete=models.CASCADE,
    )

    objects = FulfillmentDetailManager()
