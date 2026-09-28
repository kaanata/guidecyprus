import type { APIRoute } from "astro";

import { rssResponse } from "../utils/rss";

export const GET: APIRoute = ({ site, url }) => rssResponse("en", site?.toString() || url.origin);
