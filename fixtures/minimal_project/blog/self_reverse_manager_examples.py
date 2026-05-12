"""Fixture for captain regression: `self.<related_name>_set` inside class
methods. The scanner detects kwargs like `title__icontains='django'` in
`self.X_set.filter(...)`; the receiver expression is `self.X_set` whose root
identifier `self` is explicitly excluded by `receiverRootIdentifier`. The
classifier therefore labels every such lookup as `no_root_identifier` and
the resolver returns undefined.

Captain trace L81/L138 showed 23+ `self.X_set` lookups landing in
`no_root_identifier` per cycle. Desired behavior: the classifier (and ideally
the resolver) should handle the `self.X` shape more gracefully than the
generic `no_root_identifier` bucket — e.g. resolve via the enclosing class
in receivers-visible, or report a specific category like `self_reference`.
"""
from typing import Any


class StockHelper:
    """Standalone helper class — `self` here is a StockHelper instance.
    The class is intentionally not a Django model: the test cares about how
    the classifier / resolver treat the `self.<X>` shape, not whether the
    target X is a real reverse relation.
    """

    def __init__(self, raw: Any) -> None:
        self.raw = raw

    def get_active_stocks(self):
        return self.all_stock_set.filter(name__icontains='preferred')

    def get_authors(self):
        return self.author_set.filter(name__exact='Alice')

    def get_mentees(self):
        return self.mentee_set.filter(name__startswith='A')

    def get_posts(self):
        return self.post_set.filter(title__icontains='django')

    def get_tags(self):
        return self.tag_set.filter(label__endswith='!')
