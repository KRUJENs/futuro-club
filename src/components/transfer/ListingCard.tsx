/**
 * VITAS · ListingCard
 *
 * Card de un jugador en el marketplace: avatar, nombre, posición, edad,
 * VSI, tipo de operación, precio, tags.
 */
import { motion } from "framer-motion";
import { coachEvalInline } from "@/lib/metrics/coachEval";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Euro, Calendar, MapPin, ChevronRight, BadgeCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  LISTING_TYPE_LABELS,
  LISTING_STATUS_LABELS,
} from "@/lib/transfer/transferConfig";
import type { TransferListing } from "@/lib/transfer/transferTypes";
import { trustedSnapshotPhv } from "@/lib/phv/phvGate";

interface Props {
  listing: TransferListing;
  /** When provided, shows match score badge */
  matchScore?: number;
}

const LISTING_TYPE_COLOR: Record<TransferListing["listingType"], string> = {
  sale: "from-emerald-500 to-teal-500",
  loan: "from-amber-500 to-orange-500",
  trial: "from-cyan-500 to-sky-500",
};

export function ListingCard({ listing, matchScore }: Props) {
  const { t } = useTranslation();
  const snap = listing.playerSnapshot ?? {};
  const priceLabel =
    listing.askingPriceEur == null
      ? t("listingCard.negotiable")
      : new Intl.NumberFormat("es", {
          style: "currency",
          currency: listing.currency,
          maximumFractionDigits: 0,
        }).format(listing.askingPriceEur);

  return (
    <motion.div
      whileHover={{ y: -2 }}
      className="relative"
    >
      <Link
        to={`/transfer/listing/${listing.id}`}
        className="flex flex-col h-full rounded-xl border border-white/10 bg-white/[0.02] hover:border-cyan-400/40 transition-colors overflow-hidden"
      >
        {/* Top stripe with type */}
        <div
          className={cn(
            "h-1 w-full bg-gradient-to-r",
            LISTING_TYPE_COLOR[listing.listingType],
          )}
        />

        <div className="p-4 flex-1 flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="size-12 rounded-full bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center text-base font-bold text-white shrink-0 border border-white/10">
                {(snap.name ?? "?").slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-white truncate">
                  {snap.name ?? t("listingCard.playerFallback")}
                </h3>
                <div className="flex items-center gap-2 text-[10px] text-slate-400 mt-0.5">
                  <span>{snap.position ?? "?"}</span>
                  {snap.age != null && (
                    <>
                      <span>·</span>
                      <span>{t("listingCard.ageYears", { age: snap.age })}</span>
                    </>
                  )}
                  {snap.foot && (
                    <>
                      <span>·</span>
                      <span>{t("listingCard.foot", { foot: snap.foot })}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
            {matchScore != null && (
              <div
                className={cn(
                  "shrink-0 px-2 py-1 rounded-md text-xs font-semibold",
                  matchScore >= 80 && "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30",
                  matchScore >= 60 && matchScore < 80 && "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30",
                  matchScore < 60 && "bg-slate-500/20 text-slate-300 border border-slate-500/30",
                )}
              >
                {matchScore}
              </div>
            )}
          </div>

          {/* Badges */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-[10px]">
              {LISTING_TYPE_LABELS[listing.listingType]}
            </Badge>
            {snap.vsi != null && (
              <Badge variant="outline" className="text-[10px] bg-cyan-500/10 text-cyan-300 border-cyan-500/30">
                {coachEvalInline(t, snap.vsi)}
              </Badge>
            )}
            {/* PHV solo si el servidor lo marcó fiable (gate único · regla del owner). */}
            {trustedSnapshotPhv(snap).phvCategory && (
              <Badge variant="outline" className="text-[10px] bg-rose-500/10 text-rose-300 border-rose-500/30">
                PHV {trustedSnapshotPhv(snap).phvCategory}
              </Badge>
            )}
            {listing.status !== "active" && (
              <Badge className="text-[10px] bg-slate-500/15 text-slate-300">
                {LISTING_STATUS_LABELS[listing.status]}
              </Badge>
            )}
          </div>

          {/* Description preview */}
          {listing.description && (
            <p className="text-xs text-slate-400 line-clamp-2 flex-1">
              {listing.description}
            </p>
          )}

          {/* Tags */}
          {listing.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {listing.tags.slice(0, 3).map((t) => (
                <span
                  key={t}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-slate-300"
                >
                  #{t}
                </span>
              ))}
              {listing.tags.length > 3 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-slate-400">
                  +{listing.tags.length - 3}
                </span>
              )}
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-between pt-2 border-t border-white/5 mt-auto">
            <div className="flex items-center gap-1 text-sm font-semibold text-white">
              <Euro className="size-3.5 text-slate-400" />
              {priceLabel}
            </div>
            <ChevronRight className="size-4 text-slate-500" />
          </div>
        </div>
      </Link>
    </motion.div>
  );
}
