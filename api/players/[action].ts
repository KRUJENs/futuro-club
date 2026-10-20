/**
 * VITAS · Players Router
 * Routes /api/players/{action} to the correct handler.
 */
import { errorResponse } from "../_lib/apiResponse";

import search from "./_search";
import crud from "./_crud";
import maturityExport from "./_maturity-export";

export const config = { runtime: "edge" };

const routes: Record<string, (req: Request) => Promise<Response>> = {
  "search": search,
  "crud": crud,
  "maturity-export": maturityExport,
};

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const action = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const fn = routes[action];
  if (!fn) return errorResponse(`Players action "${action}" not found`, 404);
  return fn(req);
}
