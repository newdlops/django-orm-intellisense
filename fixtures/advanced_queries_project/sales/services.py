from sales.query_factory import ProductQueryFactory


class BaseProductService:
    def base_queryset(self):
        return ProductQueryFactory().call()


class QuestionThreadMessage:
    content: str

    def render_preview(self) -> str:
        raise NotImplementedError


class ProductLookupService(BaseProductService):
    @classmethod
    def available_products(cls):
        return ProductQueryFactory().call()

    def local_queryset(self):
        return super().base_queryset().filter(name__isnull=False)
