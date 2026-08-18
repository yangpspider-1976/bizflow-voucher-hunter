import Image from "next/image";
import Link from "next/link";
import {
  FiArrowRight,
} from "react-icons/fi";
import {
  CapacityIcon,
  ReferralIcon,
  ReportingIcon,
  VerifiedNumberIcon,
  VerifiedRedemptionIcon,
  WeightedPrizeIcon,
} from "./MarketingIcons";
import { resolveCampaignImage } from "@/lib/campaign-image";
import { RevealOnScroll } from "./RevealOnScroll";
import { LanguageSelector } from "./LanguageSelector";
import { BUSINESS_ENQUIRY_MAILTO, SUPPORT_EMAIL } from "@/lib/contact";
import { campaignCategoryLabel } from "@/lib/campaign-category";
import type { CampaignCard } from "@/server/voucher-engine";
import { DashboardPreview } from "./DashboardPreview";
import { dateLocale, type Language } from "@/i18n/languages";
import { translator, type TranslationKey } from "@/i18n/marketing";

/**
 * The public front door, written for business owners.
 *
 * Deliberately business-first: a shopper who already has a campaign link never
 * passes through here, and the people who need convincing are the ones deciding
 * whether to run a campaign at all. Shoppers get one clearly-signposted strip
 * near the bottom rather than a competing hero.
 *
 * Still a server component. The copy lives in four catalogues but only the
 * language that was requested is ever rendered, so the page ships no more
 * markup than it did when the strings were inline — and the only JavaScript
 * added is the language selector itself.
 *
 * Every capability named below is one the product actually has. If a claim here
 * stops being true, it is a bug in this file or in `src/i18n/marketing.ts`.
 */

/** The same app icon the dashboard sidebar and the Play listing use. */
const APP_ICON = "/images/voucher-hunt-app-logo.png";

/**
 * The repeated blocks hold catalogue keys rather than text, so the order and
 * the structure stay here while the words stay in one reviewable file.
 */
const STEPS: { title: TranslationKey; body: TranslationKey }[] = [
  { title: "how.step1.title", body: "how.step1.body" },
  { title: "how.step2.title", body: "how.step2.body" },
  { title: "how.step3.title", body: "how.step3.body" },
];

/**
 * The live customer sequence, in order. Verified against the route table in
 * `PublicStepClient` and the mobile `campaign/[slug]` screens: the draw happens
 * campaign-wide first, and `listSlotsForAttempt` then offers only the slots the
 * won tier is bound to.
 */
const CUSTOMER_JOURNEY: TranslationKey[] = [
  "how.journey1",
  "how.journey2",
  "how.journey3",
  "how.journey4",
];

const LOYALTY_STEPS: { title: TranslationKey; body: TranslationKey }[] = [
  { title: "loyalty.earn.title", body: "loyalty.earn.body" },
  { title: "loyalty.shop.title", body: "loyalty.shop.body" },
  { title: "loyalty.collect.title", body: "loyalty.collect.body" },
];

const CAPABILITIES: {
  icon: React.ReactNode;
  title: TranslationKey;
  body: TranslationKey;
}[] = [
  {
    icon: <CapacityIcon aria-hidden="true" />,
    title: "capabilities.capacity.title",
    body: "capabilities.capacity.body",
  },
  {
    icon: <WeightedPrizeIcon aria-hidden="true" />,
    title: "capabilities.prizes.title",
    body: "capabilities.prizes.body",
  },
  {
    icon: <VerifiedRedemptionIcon aria-hidden="true" />,
    title: "capabilities.redemption.title",
    body: "capabilities.redemption.body",
  },
  {
    icon: <VerifiedNumberIcon aria-hidden="true" />,
    title: "capabilities.numbers.title",
    body: "capabilities.numbers.body",
  },
  {
    icon: <ReferralIcon aria-hidden="true" />,
    title: "capabilities.referrals.title",
    body: "capabilities.referrals.body",
  },
  {
    icon: <ReportingIcon aria-hidden="true" />,
    title: "capabilities.reporting.title",
    body: "capabilities.reporting.body",
  },
];

function formatRange(start: string, end: string, locale: string) {
  const fmt = (value: string) => {
    const parsed = new Date(`${value}T00:00:00`);
    return Number.isNaN(parsed.getTime())
      ? value
      : parsed.toLocaleDateString(locale, { month: "short", day: "numeric" });
  };
  return `${fmt(start)} – ${fmt(end)}`;
}

export function MarketingHome({
  campaigns,
  language,
}: {
  campaigns: CampaignCard[];
  language: Language;
}) {
  const t = translator(language);
  const locale = dateLocale(language);

  // Proof, not filler: with nothing live the section is dropped rather than
  // shown empty, which would argue against the page it sits on. Finished
  // campaigns ride along in the directory feed for the app's benefit; they
  // prove nothing here, so they are left out.
  const showcase = campaigns.filter((card) => !card.ended).slice(0, 3);

  return (
    // `lang` sits here rather than on <html> so the root layout stays static for
    // every other route: it is scoped to this subtree, which is the only part of
    // the site that is translated.
    <div className="marketing" lang={language}>
      <RevealOnScroll />
      <header className="marketing-nav">
        <div className="marketing-shell marketing-nav-inner">
          <Link className="marketing-wordmark" href="/">
            <Image
              alt=""
              className="marketing-mark"
              height={32}
              priority
              src={APP_ICON}
              width={32}
            />
            Voucher&nbsp;Hunt
          </Link>

          <nav className="marketing-nav-links" aria-label={t("nav.sections")}>
            <a href="#how-it-works">{t("nav.howItWorks")}</a>
            <a href="#loyalty">{t("nav.loyalty")}</a>
            <a href="#capabilities">{t("nav.capabilities")}</a>
            <a href="#dashboard">{t("nav.dashboard")}</a>
            {showcase.length > 0 ? <a href="#demo">{t("nav.demo")}</a> : null}
          </nav>

          <div className="marketing-nav-actions">
            <LanguageSelector language={language} />
            <Link className="marketing-nav-switcher" href="/client">
              {t("nav.forClients")}
            </Link>
            <Link className="marketing-nav-login" href="/login">
              {t("nav.businessLogin")}
            </Link>
            <a className="marketing-button" href={BUSINESS_ENQUIRY_MAILTO}>
              {t("nav.talkToUs")}
            </a>
          </div>
        </div>
      </header>

      <main>
        {/*
         * The background lives in its own layer so artwork can be dropped on
         * `.marketing-hero-bg` without touching this markup or the copy's
         * stacking. `.marketing-hero.is-dark` flips the copy to white and
         * deepens the scrim for dark photography.
         */}
        <section className="marketing-hero has-art">
          <div className="marketing-hero-bg" aria-hidden="true" />
          <div className="marketing-shell marketing-hero-inner">
            <p className="marketing-eyebrow" data-rise="1">
              {t("hero.eyebrow")}
            </p>
            <h1 data-rise="2">{t("hero.title")}</h1>
            <p className="marketing-hero-lead" data-rise="3">
              {t("hero.lead")}
            </p>
            <div className="marketing-cta-row" data-rise="4">
              <a className="marketing-button marketing-button-lg" href={BUSINESS_ENQUIRY_MAILTO}>
                {t("nav.talkToUs")}
                <FiArrowRight aria-hidden="true" />
              </a>
              <Link className="marketing-button-ghost marketing-button-lg" href="/login">
                {t("nav.businessLogin")}
              </Link>
            </div>
            <p className="marketing-hero-note" data-rise="5">
              {t("hero.note")}
            </p>
          </div>
        </section>

        <section className="marketing-section marketing-section-tight">
          <div className="marketing-shell">
            <div className="marketing-problem-grid">
              <div data-reveal>
                <p className="marketing-eyebrow">{t("problem.eyebrow")}</p>
                <h2>{t("problem.title")}</h2>
              </div>
              <ul className="marketing-problem-list">
                <li data-reveal="1">
                  <strong>{t("problem.when.lead")}</strong>{" "}
                  {t("problem.when.body")}
                </li>
                <li data-reveal="2">
                  <strong>{t("problem.many.lead")}</strong>{" "}
                  {t("problem.many.body")}
                </li>
                <li data-reveal="3">
                  <strong>{t("problem.worked.lead")}</strong>{" "}
                  {t("problem.worked.body")}
                </li>
              </ul>
            </div>
          </div>
        </section>

        <section className="marketing-section marketing-how-it-works" id="how-it-works">
          <div className="marketing-shell">
            <div className="marketing-section-head" data-reveal>
              <p className="marketing-eyebrow">{t("how.eyebrow")}</p>
              <h2>{t("how.title")}</h2>
              <p className="marketing-section-lead">{t("how.lead")}</p>
            </div>

            <ol className="marketing-steps">
              {STEPS.map((step, index) => (
                <li
                  className="marketing-step"
                  data-reveal={String(index + 1)}
                  key={step.title}
                >
                  <span className="marketing-step-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <h3>{t(step.title)}</h3>
                  <p>{t(step.body)}</p>
                </li>
              ))}
            </ol>

            {/* Spelled out because the order is the whole product: the prize is
                drawn first, and the slot is picked from the windows that prize
                is valid at. Stating it backwards is what the copy above used
                to do. */}
            <div className="marketing-journey" data-reveal>
              <p className="marketing-journey-label">{t("how.journeyLabel")}</p>
              <ol className="marketing-journey-steps">
                {CUSTOMER_JOURNEY.map((stage) => (
                  <li className="marketing-journey-step" key={stage}>
                    {t(stage)}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        <section className="marketing-section marketing-loyalty" id="loyalty">
          <div className="marketing-shell">
            <div className="marketing-section-head" data-reveal>
              <p className="marketing-eyebrow">{t("loyalty.eyebrow")}</p>
              <h2>{t("loyalty.title")}</h2>
              <p className="marketing-section-lead">{t("loyalty.lead")}</p>
            </div>

            <ol className="marketing-loyalty-steps">
              {LOYALTY_STEPS.map((step, index) => (
                <li data-reveal={String(index + 1)} key={step.title}>
                  <span className="marketing-loyalty-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <div>
                    <h3>{t(step.title)}</h3>
                    <p>{t(step.body)}</p>
                  </div>
                </li>
              ))}
            </ol>

            <p className="marketing-loyalty-note" data-reveal>
              {t("loyalty.note")}
            </p>
          </div>
        </section>

        <section
          className="marketing-section marketing-section-alt marketing-capabilities-section"
          id="capabilities"
        >
          <div className="marketing-shell">
            <div className="marketing-section-head" data-reveal>
              <p className="marketing-eyebrow">{t("capabilities.eyebrow")}</p>
              <h2>{t("capabilities.title")}</h2>
              <p className="marketing-section-lead">{t("capabilities.lead")}</p>
            </div>

            <div className="marketing-capabilities">
              {CAPABILITIES.map((capability, index) => (
                <article
                  className="marketing-capability"
                  // Cycles 1-4 so each row of four staggers, rather than the
                  // last card waiting on seven delays before it appears.
                  data-reveal={String((index % 4) + 1)}
                  key={capability.title}
                >
                  <span className="marketing-capability-icon">{capability.icon}</span>
                  <h3>{t(capability.title)}</h3>
                  <p>{t(capability.body)}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="marketing-section marketing-product-preview" id="dashboard">
          <div className="marketing-shell marketing-product-preview-grid">
            <div className="marketing-product-preview-copy" data-reveal>
              <p className="marketing-eyebrow">{t("dashboard.eyebrow")}</p>
              <h2>{t("dashboard.title")}</h2>
              <p>{t("dashboard.body")}</p>
              <ul>
                <li>{t("dashboard.item1")}</li>
                <li>{t("dashboard.item2")}</li>
                <li>{t("dashboard.item3")}</li>
              </ul>
            </div>

            <DashboardPreview />
          </div>
        </section>

        {showcase.length > 0 ? (
          <section className="marketing-section" id="demo">
            <div className="marketing-shell">
              <div className="marketing-section-head" data-reveal>
                <p className="marketing-eyebrow">{t("demo.eyebrow")}</p>
                <h2>{t("demo.title")}</h2>
                <p className="marketing-section-lead">{t("demo.lead")}</p>
              </div>

              <div className="marketing-campaigns">
                {showcase.map(({ campaign, businessName, businessIndustry }, index) => {
                  const image = resolveCampaignImage(campaign);
                  return (
                    <article
                      className="marketing-campaign"
                      data-reveal={String(index + 1)}
                      key={campaign.id}
                    >
                      <div className="marketing-campaign-media">
                        {image ? (
                          <Image
                            alt={image.alt}
                            fill
                            sizes="(max-width: 900px) 100vw, 360px"
                            src={image.src}
                            unoptimized
                          />
                        ) : (
                          <span className="marketing-campaign-fallback" aria-hidden="true">
                            {businessName.slice(0, 2).toUpperCase()}
                          </span>
                        )}
                      </div>
                      <div className="marketing-campaign-body">
                        {/* Campaign titles, business names and category labels
                            are tenant data, not UI copy — they stay in whatever
                            language the business entered them in. */}
                        <span className="marketing-chip">
                          {campaignCategoryLabel(businessIndustry)}
                        </span>
                        <h3>{campaign.title}</h3>
                        <p className="marketing-campaign-business">{businessName}</p>
                        <p className="marketing-campaign-dates">
                          {formatRange(campaign.startDate, campaign.endDate, locale)}
                        </p>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          </section>
        ) : null}

        <section className="marketing-section marketing-section-tight">
          <div className="marketing-shell">
            <div className="marketing-closer" data-reveal>
              <div>
                <h2>{t("closer.title")}</h2>
                <p>{t("closer.body")}</p>
              </div>
              <a className="marketing-button marketing-button-lg" href={BUSINESS_ENQUIRY_MAILTO}>
                {t("nav.talkToUs")}
                <FiArrowRight aria-hidden="true" />
              </a>
            </div>
          </div>
        </section>

        {/* Customer traffic gets a dedicated landing page rather than entering
            the retired browser version of the customer app. */}
        <section className="marketing-shopper">
          <div className="marketing-shell marketing-shopper-inner" data-reveal>
            <div>
              <p className="marketing-eyebrow">{t("shopper.eyebrow")}</p>
              <p className="marketing-shopper-copy">{t("shopper.copy")}</p>
            </div>
            <div className="marketing-cta-row">
              <Link className="marketing-button-ghost" href="/client">
                {t("nav.forClients")}
                <FiArrowRight aria-hidden="true" />
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="marketing-footer">
        <div className="marketing-shell marketing-footer-inner">
          <span className="marketing-wordmark">
            <Image
              alt=""
              className="marketing-mark"
              height={32}
              priority
              src={APP_ICON}
              width={32}
            />
            Voucher&nbsp;Hunt
          </span>
          <nav className="marketing-footer-links" aria-label={t("footer.legalLabel")}>
            <Link href="/privacy">{t("footer.privacy")}</Link>
            <Link href="/delete-account">{t("footer.deleteAccount")}</Link>
            <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
