from sales.models import Product
from sales.services import ProductLookupService


def queryset_examples():
    active_products = Product.objects.active()
    active_products.values("category__ti")
    active_products.values("category__title")
    active_products.filter(category__sl='chairs')
    active_products.filter(
        category__ti='chairs',
    )
    Product.objects.active().filter(category__sl='chairs')
    (
        Product.objects.active()
        .filter(category__sl='chairs')
        .select_related("category")
        .values("category__ti")
    )


def build_products():
    return ProductLookupService.available_products()


def helper_examples():
    build_products().filter(category__sl='chairs')
    build_products().values("category__ti")
    build_products().values("category__title")


class ReceiverExamples(ProductLookupService):
    @classmethod
    def classmethod_examples(cls):
        return cls.available_products().filter(category__sl='chairs')

    def method_examples(self):
        self.local_queryset().filter(category__sl='chairs')
        self.local_queryset().values("category__ti")
        self.local_queryset().values("category__title")
        super().base_queryset().filter(category__sl='chairs')


def member_examples():
    manager = Product.objects
    manager.ac
    manager.with_li

    queryset = Product.objects.active()
    queryset.fi
    queryset.with_li

    instance = Product.objects.get(id=1)
    instance.na
    instance.category.ti

    Product.objects.first().ca
    Product.objects.active().first().na
    Product.objects.active().first().category.ti
    Product.objects.active().with_line_co
    Product.objects.active().with_line_count()
