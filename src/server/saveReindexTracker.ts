/** Initial document synchronization is not an edit. Real edits remain dirty
 * regardless of the number of documents edited within the same time window. */
export class SaveReindexTracker {
  private initialContent = new Set<string>();
  private dirty = new Set<string>();

  opened(uri: string): void {
    this.initialContent.add(uri);
  }

  changed(uri: string): void {
    if (this.initialContent.delete(uri)) return;
    this.dirty.add(uri);
  }

  saved(uri: string): boolean {
    return this.dirty.delete(uri);
  }

  closed(uri: string): void {
    this.initialContent.delete(uri);
    this.dirty.delete(uri);
  }
}
