/**
 * VITAS · CreateListingForm
 *
 * Form para publicar un jugador en el marketplace. Permite seleccionar el
 * jugador (de PlayerService) y rellenar tipo/precio/descripción/tags.
 */

import { useMemo, useState } from "react";
import { coachEvalInline } from "@/lib/metrics/coachEval";
import { useTranslation } from "react-i18next";
import { Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

import { PlayerService } from "@/services/real/playerService";
import { useCreateListing } from "@/hooks/useTransferMarket";
import {
  LISTING_TYPES,
  LISTING_TYPE_LABELS,
  VISIBILITY_LEVELS,
  PUBLISHER_ROLES,
  PUBLISHER_ROLE_LABELS,
  DEFAULTS,
} from "@/lib/transfer/transferConfig";
import type {
  ListingType,
  ListingVisibility,
  PublisherRole,
} from "@/lib/transfer/transferConfig";

interface Props {
  onCreated: (listingId: string) => void;
}

export function CreateListingForm({ onCreated }: Props) {
  const { t } = useTranslation();
  const players = useMemo(() => PlayerService.getAll(), []);
  const createListing = useCreateListing();

  const [playerId, setPlayerId] = useState(players[0]?.id ?? "");
  const [listingType, setListingType] = useState<ListingType>("sale");
  const [publisherRole, setPublisherRole] = useState<PublisherRole>("club");
  const [visibility, setVisibility] = useState<ListingVisibility>("public");
  const [askingPriceEur, setAskingPriceEur] = useState<string>("");
  const [acceptsOffers, setAcceptsOffers] = useState(true);
  const [description, setDescription] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<number>(DEFAULTS.listingTtlDays);
  const [activateNow, setActivateNow] = useState(true);

  const selectedPlayer = players.find((p) => p.id === playerId);

  async function handleSubmit() {
    if (!selectedPlayer) {
      toast.error(t("createListingForm.selectPlayerError"));
      return;
    }

    const tags = tagsInput
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 15);

    const playerSnapshot = {
      name: selectedPlayer.name,
      age: (selectedPlayer as unknown as { age?: number }).age,
      position: (selectedPlayer as unknown as { position?: string }).position,
      foot: (selectedPlayer as unknown as { foot?: string }).foot,
      vsi: (selectedPlayer as unknown as { vsi?: number }).vsi,
      // Sin phvCategory/phvOffset: el servidor los copia de las columnas gateadas
      // del jugador (api/transfer/_create-listing.ts) y los marca phvTrusted.
    };

    try {
      const listing = await createListing.mutateAsync({
        playerId,
        publisherRole,
        listingType,
        askingPriceEur: askingPriceEur ? parseFloat(askingPriceEur) : null,
        currency: "EUR",
        acceptsOffers,
        visibility,
        description: description.trim() || undefined,
        tags,
        playerSnapshot,
        sellerName: "Club VITAS",
        status: activateNow ? "active" : "draft",
        expiresInDays,
      });
      toast.success(t("createListingForm.listingCreated"));
      onCreated(listing.id);
    } catch (err) {
      toast.error(t("createListingForm.listingCreateError"), {
        description: err instanceof Error ? err.message : "Error",
      });
    }
  }

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Player selector */}
      <section>
        <label className="text-xs font-medium text-slate-300 mb-2 block">
          {t("createListingForm.playerToPublish")}
        </label>
        {players.length === 0 ? (
          <div className="text-xs text-amber-300 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            {t("createListingForm.noPlayers")} <Button variant="link" className="text-amber-200 underline px-1 h-auto" onClick={() => (window.location.href = "/players/new")}>{t("createListingForm.createPlayer")}</Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto">
            {players.map((p) => (
              <button
                key={p.id}
                onClick={() => setPlayerId(p.id)}
                className={`text-left p-2 rounded-lg border transition-colors ${
                  playerId === p.id
                    ? "bg-cyan-500/15 border-cyan-400/50"
                    : "bg-white/[0.02] border-white/10 hover:border-white/25"
                }`}
              >
                <div className="text-sm font-medium text-white">{p.name}</div>
                <div className="text-[10px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                  <span>{(p as unknown as { position?: string }).position ?? "?"}</span>
                  <span>·</span>
                  <span>{t("createListingForm.ageYears", { age: (p as unknown as { age?: number }).age ?? "?" })}</span>
                  {typeof (p as unknown as { vsi?: number }).vsi === "number" && (
                    <>
                      <span>·</span>
                      <span>{coachEvalInline(t, (p as unknown as { vsi: number | null }).vsi)}</span>
                    </>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Listing type */}
      <section>
        <label className="text-xs font-medium text-slate-300 mb-2 block">
          {t("createListingForm.operationType")}
        </label>
        <div className="flex flex-wrap gap-2">
          {LISTING_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => setListingType(t)}
              className={`px-3 py-1.5 rounded-md border text-xs transition-colors ${
                listingType === t
                  ? "bg-cyan-500/20 border-cyan-400/50 text-cyan-200"
                  : "bg-white/[0.02] border-white/10 text-slate-400 hover:border-white/25"
              }`}
            >
              {LISTING_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
      </section>

      {/* Publisher role */}
      <section>
        <label className="text-xs font-medium text-slate-300 mb-2 block">
          {t("createListingForm.publishedBy")}
        </label>
        <div className="flex flex-wrap gap-2">
          {PUBLISHER_ROLES.map((r) => (
            <button
              key={r}
              onClick={() => setPublisherRole(r)}
              className={`px-3 py-1.5 rounded-md border text-xs transition-colors ${
                publisherRole === r
                  ? "bg-violet-500/20 border-violet-400/50 text-violet-200"
                  : "bg-white/[0.02] border-white/10 text-slate-400 hover:border-white/25"
              }`}
            >
              {PUBLISHER_ROLE_LABELS[r]}
            </button>
          ))}
        </div>
      </section>

      {/* Price + accepts offers */}
      <section>
        <label className="text-xs font-medium text-slate-300 mb-2 block">
          {t("createListingForm.priceLabel")}
        </label>
        <div className="flex items-center gap-3">
          <Input
            type="number"
            value={askingPriceEur}
            onChange={(e) => setAskingPriceEur(e.target.value)}
            placeholder={t("createListingForm.pricePlaceholder")}
            className="bg-white/[0.02] border-white/10 max-w-[180px]"
          />
          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={acceptsOffers}
              onChange={(e) => setAcceptsOffers(e.target.checked)}
              className="accent-cyan-500"
            />
            {t("createListingForm.acceptsOffers")}
          </label>
        </div>
      </section>

      {/* Description */}
      <section>
        <label className="text-xs font-medium text-slate-300 mb-2 block">
          {t("createListingForm.description")}
        </label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("createListingForm.descriptionPlaceholder")}
          rows={3}
          className="bg-white/[0.02] border-white/10 text-sm"
        />
      </section>

      {/* Tags */}
      <section>
        <label className="text-xs font-medium text-slate-300 mb-2 block">
          {t("createListingForm.tagsLabel")}
        </label>
        <Input
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          placeholder={t("createListingForm.tagsPlaceholder")}
          className="bg-white/[0.02] border-white/10"
        />
        {tagsInput && (
          <div className="flex flex-wrap gap-1 mt-2">
            {tagsInput
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
              .slice(0, 15)
              .map((t, i) => (
                <Badge key={i} variant="outline" className="text-[10px]">
                  #{t}
                </Badge>
              ))}
          </div>
        )}
      </section>

      {/* Visibility + expires */}
      <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-slate-300 mb-2 block">
            {t("createListingForm.visibility")}
          </label>
          <div className="flex gap-2">
            {VISIBILITY_LEVELS.map((v) => (
              <button
                key={v}
                onClick={() => setVisibility(v)}
                className={`flex-1 px-3 py-1.5 rounded-md border text-xs ${
                  visibility === v
                    ? "bg-cyan-500/15 border-cyan-400/50 text-cyan-200"
                    : "bg-white/[0.02] border-white/10 text-slate-400"
                }`}
              >
                {v === "public" ? t("createListingForm.visibilityPublic") : t("createListingForm.visibilityPrivate")}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-300 mb-2 block">
            {t("createListingForm.expiresInDays")}
          </label>
          <Input
            type="number"
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(parseInt(e.target.value, 10) || DEFAULTS.listingTtlDays)}
            className="bg-white/[0.02] border-white/10 max-w-[120px]"
          />
        </div>
      </section>

      {/* Activate now */}
      <section>
        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={activateNow}
            onChange={(e) => setActivateNow(e.target.checked)}
            className="accent-cyan-500"
          />
          {t("createListingForm.publishNow")}
        </label>
      </section>

      {/* Submit */}
      <Button
        onClick={handleSubmit}
        disabled={createListing.isPending || !selectedPlayer}
        size="lg"
        className="w-full"
      >
        {createListing.isPending ? (
          <Loader2 className="size-4 mr-2 animate-spin" />
        ) : (
          <Sparkles className="size-4 mr-2" />
        )}
        {activateNow ? t("createListingForm.publishToMarketplace") : t("createListingForm.saveAsDraft")}
      </Button>
    </div>
  );
}
