from sales.models import Product


class ProductQueryFactory:
    def call(self):
        return (
            Product.objects.active()
            .select_related("category")
            .order_by("id")
        )
