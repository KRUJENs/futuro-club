/**
 * VITAS · Catch-all API Router
 * Handles scattered endpoints consolidated into one Vercel function.
 */
import { errorResponse } from "./_lib/apiResponse";

import pipelineStart from "./pipeline/_start";
import playersSearch from "./players/_search";
import playersCrud from "./players/_crud";
import fixturesLive from "./fixtures/_live";
import trackingSave from "./tracking/_save";
import audit from "./_audit";
import roboflowAnalyze from "./roboflow/_analyze";
import uploadImage from "./upload/_image";
import uploadVideoInit from "./upload/_video-init";
import health from "./health";
import scoutGenerate from "./scout/generate";
import scoutInsights from "./scout/insights";
import scoutAutoGenerate from "./scout/auto-generate";
import rankingsList from "./rankings/_list";
import reportsPdf from "./reports/_pdf";
import accountDelete from "./account/_delete";
import authWelcome from "./auth/_welcome";
import authVerifyCaptcha from "./auth/_verify-captcha";
import authWithdrawConsent from "./auth/_withdraw-consent";

export const config = { runtime: "edge" };

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Remove /api/ prefix and split
  const path = url.pathname.replace(/^\/api\/?/, "");
  const segments = path.split("/").filter(Boolean);

  // Match routes
  const key = segments.join("/");

  // Static routes
  const staticRoutes: Record<string, (req: Request) => Promise<Response>> = {
    "health": health,
    "pipeline/start": pipelineStart,
    "players/search": playersSearch,
    "players/crud": playersCrud,
    "fixtures/live": fixturesLive,
    "tracking/save": trackingSave,
    "audit": audit,
    "roboflow/analyze": roboflowAnalyze,
    "upload/image": uploadImage,
    "upload/video-init": uploadVideoInit,
    "scout/generate": scoutGenerate,
    "scout/insights": scoutInsights,
    "scout/auto-generate": scoutAutoGenerate,
    "rankings/list": rankingsList,
    "reports/pdf": reportsPdf,
    "account/delete": accountDelete,
    "auth/welcome": authWelcome,
    "auth/verify-captcha": authVerifyCaptcha,
    "auth/withdraw-consent": authWithdrawConsent,
  };

  if (staticRoutes[key]) return staticRoutes[key](req);

  return errorResponse(`Route "/api/${key}" not found`, 404);
}
