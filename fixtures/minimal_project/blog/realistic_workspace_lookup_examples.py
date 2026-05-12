from blog import Author, Post


class AuthorService:
    author: Author

    @classmethod
    def active_authors(cls):
        return Author.objects.filter(name__contains="active")

    @classmethod
    def by_substring(cls, needle):
        return Author.objects.filter(name__contains=needle).exclude(
            name__startswith="_"
        )

    def __init__(self, author: Author):
        self.author = author

    @property
    def published_posts(self):
        return self.author.posts.filter(published=True)

    def chained_filters(self):
        return (
            Post.objects
            .filter(title__contains="a")
            .filter(title__contains="b")
            .exclude(title__endswith="c")
        )

    def chain_with_order_and_values(self):
        return (
            Post.objects
            .filter(author__name__contains="x")
            .order_by("author__name")
            .values("title", "published")
        )

    def chain_with_values_list(self):
        return (
            Post.objects
            .filter(published=True)
            .values_list("title", flat=True)
        )

    def deeply_chained(self):
        return (
            Post.objects
            .filter(author__name__startswith="A")
            .exclude(title__endswith="x")
            .filter(title__icontains="hello")
            .filter(title__contains="world")
            .order_by("-published")
        )

    def via_self_relation(self):
        self.author.posts.filter(title__contains="self")
        self.author.posts.filter(title__icontains="self")
        self.author.posts.exclude(title__startswith="_")
        self.author.posts.filter(published=True).filter(title__contains="x")


def author_post_chain(author: Author):
    return author.posts.filter(title__contains="z").order_by("title")
