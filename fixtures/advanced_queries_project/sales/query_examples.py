from django.db import models
from django.db.models import Case, QuerySet, Value, When

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


def build_product_instance():
    return Product.objects.get(id=1)


def helper_examples():
    build_products().filter(category__sl='chairs')
    build_products().values("category__ti")
    build_products().values("category__title")


def expression_examples():
    Product.objects.annotate(line_count=models.Count("li"))
    Product.objects.annotate(total_quantity=models.Sum("lines__quantity")).first().to
    Product.objects.annotate(avg_quantity=models.Avg("lines__quantity")).first().av
    Product.objects.annotate(first_name=models.Min("name")).first().fi
    Product.objects.annotate(last_name=models.Max("name")).first().la
    Product.objects.annotate(line_count=models.Count("li")).filter(line_co=1)
    Product.objects.annotate(line_count=models.Count("li")).filter(line_count__g=1)
    Product.objects.annotate(line_count=models.Count("li")).filter(line_count__bog=1)
    Product.objects.annotate(category_title=models.F("category__ti"))
    Product.objects.annotate(category_title_text=models.Cast("category__ti", output_field=models.CharField()))
    Product.objects.annotate(category_title_lower=models.Func("category__ti", function="LOWER"))
    Product.objects.annotate(category_title_or_name=models.Coalesce("category__ti", "na"))
    Product.objects.alias(line_total=models.Count("li")).filter(line_to=1)
    Product.objects.alias(line_total=models.Count("li")).filter(line_total__g=1)
    Product.objects.alias(line_total=models.Count("lines")).filter(line_total__gt=1)
    Product.objects.alias(line_total=models.Count("li")).filter(line_total__bog=1)
    Product.objects.alias(line_total=models.Count("li")).order_by("line_to")
    Product.objects.annotate(
        category_bucket=Case(
            When(category__sl='chairs', then=Value('chairs')),
            default=Value('other'),
        )
    ).first().ca
    Product.objects.annotate(category_bucket=Case(When(category__sl='chairs', then=Value('chairs')), default=Value('other'))).first().ca
    Product.objects.annotate(category_bucket=Case(When(category__slug='chairs', then=Value('chairs')), default=Value('other')))
    Product.objects.annotate(category_title_text=models.Cast("category__ti", output_field=models.CharField())).first().ca_t
    Product.objects.annotate(category_title_text=models.Cast("category__title", output_field=models.CharField()))
    Product.objects.annotate(category_title_lower=models.Func("category__ti", function="LOWER")).first().ca_t_l
    Product.objects.annotate(category_title_or_name=models.Coalesce("category__ti", "na")).first().ca_t_o
    Product.objects.annotate(weighted_name=models.ExpressionWrapper(models.F("na"), output_field=models.CharField()))
    Product.objects.annotate(weighted_name=models.ExpressionWrapper(models.F("na"), output_field=models.CharField())).first().we
    Product.objects.annotate(matching_name=models.Subquery(Product.objects.filter(pk=models.OuterRef("na")).values("category__sl")[:1]))
    Product.objects.annotate(matching_name=models.Subquery(Product.objects.filter(pk=models.OuterRef("name")).values("category__sl")[:1]))
    Product.objects.annotate(matching_name=models.Subquery(Product.objects.filter(pk=models.OuterRef("name")).values("category__sl")[:1])).first().ma
    Product.objects.annotate(matching_name=models.Subquery(Product.objects.filter(pk=models.OuterRef("bo")).values("category__sl")[:1]))
    Product.objects.annotate(has_active_category=models.Exists(Product.objects.filter(pk=models.OuterRef("pk"), category__sl='chairs')))
    Product.objects.aggregate(line_total=models.Count("li"))
    Product.objects.aggregate(line_total=models.Count("lines"))
    Product.objects.aggregate(line_total=models.Count("bo"))


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
    instance.
    instance.na
    instance.category.ti

    dynamic_instance = build_product_instance()
    dynamic_instance.
    dynamic_instance.category.ti

    Product.objects.first().ca
    Product.objects.active().first().na
    Product.objects.active().first().category.ti
    Product.objects.active().annotate(line_count=models.Count("lines")).first().li
    Product.objects.active().with_line_count().first().li
    Product.objects.active().with_line_count().filter(line_co=1)
    Product.objects.annotate(has_active_category=models.Exists(Product.objects.filter(pk=models.OuterRef("pk"), category__sl='chairs'))).first().ha
    Product.objects.active().with_line_co
    Product.objects.active().with_line_count()


def loop_examples(products: list[Product], queryset_groups: list[QuerySet[Product]]):
    for loop_product in Product.objects.active():
        loop_product.category.ti

    for typed_product in products:
        typed_product.category.ti

    for typed_queryset in queryset_groups:
        typed_queryset.with_li
        typed_queryset.values("category__ti")
