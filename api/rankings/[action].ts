/**
 * VITAS · Rankings Router
 */
import { errorResponse } from "../_lib/apiResponse";
import list from "./_list";
import nlFilters from "./_nl-filters";

const routes: Record<string, (req: Request) => Promise<Response>> = {
  list,
  "nl-filters": nlFilters,
};

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const action = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const fn = routes[action];
  if (!fn) return errorResponse(`Rankings route "${action}" not found`, 404);
  return fn(req);
}
