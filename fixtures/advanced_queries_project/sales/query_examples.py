from sales.models import Product


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
