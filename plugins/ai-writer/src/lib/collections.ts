// What a collection supports, so image, excerpt, SEO and taxonomy work is
// only done where the collection can store it (posts have all of them; pages
// have no featured image, SEO or taxonomies).

/** Read from EmDash's schema registry and taxonomy definitions (see sandbox-entry.ts). */
export type CollectionInfo = { fields: string[]; hasSeo: boolean; taxonomies: string[] };

export type CollectionFeatures = {
  featuredImage: boolean;
  excerpt: boolean;
  seo: boolean;
  categories: boolean;
  tags: boolean;
};

export const FEATURED_IMAGE_FIELD = "featured_image";
export const EXCERPT_FIELD = "excerpt";

/**
 * Features of a collection. When its schema is unknown everything but SEO is
 * attempted (EmDash rejects an `seo` write on a collection without SEO).
 */
export function featuresOf(info: CollectionInfo | null | undefined): CollectionFeatures {
  if (!info) return { featuredImage: true, excerpt: true, seo: false, categories: true, tags: true };
  const fields = new Set(info.fields);
  return {
    featuredImage: fields.has(FEATURED_IMAGE_FIELD),
    excerpt: fields.has(EXCERPT_FIELD),
    seo: info.hasSeo,
    categories: info.taxonomies.includes("category"),
    tags: info.taxonomies.includes("tag"),
  };
}

export type GetCollectionInfo = (collection: string) => Promise<CollectionInfo | null>;

/** Best-effort lookup: a failure reads as "unknown collection". */
export async function collectionFeatures(
  get: GetCollectionInfo | undefined,
  collection: string,
  log?: (message: string) => void,
): Promise<CollectionFeatures> {
  try {
    return featuresOf(get ? await get(collection) : null);
  } catch (err) {
    log?.(`Collection "${collection}" could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return featuresOf(null);
  }
}
