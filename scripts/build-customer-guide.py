"""
Builds the "Voucher Hunt — Customer Guide" Word document.

The document is a deliverable, not source: it is regenerated from here so the
wording stays reviewable in git and cannot drift silently from the product.

    pip install python-docx
    python scripts/build-customer-guide.py

Screenshots are optional. Drop PNGs into docs/images/ using the filenames in
SHOTS below and they are embedded automatically; anything missing leaves a
short placeholder line instead.

Wording is taken from the app's own English catalogue,
apps/mobile/src/i18n/translations.ts. When a button is named in bold here, it
is quoted from that file — change one and change the other.
"""

from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt, RGBColor

ROOT = Path(__file__).resolve().parent.parent
IMAGES = ROOT / "docs" / "images"
OUTPUT = ROOT / "docs" / "Voucher Hunt — Customer Guide.docx"

INK = RGBColor(0x0B, 0x1D, 0x3A)
MUTED = RGBColor(0x5B, 0x66, 0x7A)
PURPLE = RGBColor(0x5C, 0x3D, 0xFF)

SHOTS = {
    "signin": ("customer-00-signin.png", "Signing in with your mobile number"),
    "directory": ("customer-01-directory.png", "The Home tab, showing live campaigns"),
    "campaign": ("customer-02-campaign.png", "A campaign page, ready to start"),
    "roulette": ("customer-03-roulette.png", "The reel mid-spin"),
    "datetime": ("customer-04-datetime.png", "Choosing a date and time slot"),
    "voucher": ("customer-05-voucher.png", "The issued voucher, with its QR code"),
    "more": ("customer-06-more.png", "The More tab, with your Loyalty Points and wallet QR"),
    "quests": ("customer-07-quests.png", "The Quests tab, showing today's missions"),
    "shop": ("customer-08-shop.png", "The LP Shop, listing partner rewards"),
}


def shot(doc, key):
    """Embeds the screenshot if it exists, else leaves a light placeholder."""
    filename, caption = SHOTS[key]
    path = IMAGES / filename
    if path.exists():
        doc.add_picture(str(path), width=Inches(2.6))
        doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
        line = doc.add_paragraph(caption)
        line.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = line.runs[0]
        run.italic = True
        run.font.size = Pt(9)
        run.font.color.rgb = MUTED
        return
    line = doc.add_paragraph(f"[ Screenshot: {caption} — docs/images/{filename} ]")
    run = line.runs[0]
    run.italic = True
    run.font.size = Pt(9)
    run.font.color.rgb = MUTED


def body(doc, text, bold_lead=None):
    paragraph = doc.add_paragraph()
    if bold_lead:
        lead = paragraph.add_run(bold_lead)
        lead.bold = True
    paragraph.add_run(text)
    return paragraph


def step(doc, number, title):
    heading = doc.add_heading(f"Step {number} — {title}", level=2)
    heading.runs[0].font.color.rgb = INK
    return heading


def bullets(doc, lines):
    for line in lines:
        if isinstance(line, tuple):
            lead, rest = line
            bullet = doc.add_paragraph(style="List Bullet")
            run = bullet.add_run(lead)
            run.bold = True
            bullet.add_run(rest)
        else:
            doc.add_paragraph(line, style="List Bullet")


def numbered(doc, lines):
    for line in lines:
        if isinstance(line, tuple):
            lead, rest = line
            item = doc.add_paragraph(style="List Number")
            run = item.add_run(lead)
            run.bold = True
            item.add_run(rest)
        else:
            doc.add_paragraph(line, style="List Number")


def result_line(doc, text):
    """One line on how the reader knows the step worked."""
    paragraph = doc.add_paragraph()
    run = paragraph.add_run("You will know it worked: ")
    run.bold = True
    run.font.color.rgb = MUTED
    tail = paragraph.add_run(text)
    tail.font.color.rgb = MUTED
    return paragraph


def two_column_table(doc, rows, headers=None):
    table = doc.add_table(rows=0, cols=2)
    table.style = "Light List Accent 1"
    if headers:
        cells = table.add_row().cells
        for index, heading in enumerate(headers):
            cells[index].text = heading
            cells[index].paragraphs[0].runs[0].bold = True
    for name, detail in rows:
        cells = table.add_row().cells
        cells[0].text = name
        cells[1].text = detail
        cells[0].paragraphs[0].runs[0].bold = True
    return table


def build():
    doc = Document()

    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11)
    normal.font.color.rgb = INK
    normal.paragraph_format.space_after = Pt(8)

    title = doc.add_heading("Voucher Hunt", level=0)
    title.runs[0].font.color.rgb = PURPLE
    subtitle = doc.add_paragraph("Customer Guide — how to use the app")
    subtitle.runs[0].font.size = Pt(13)
    subtitle.runs[0].font.color.rgb = MUTED

    body(
        doc,
        "This guide takes you from installing the app to using a voucher at the "
        "counter and spending the points you earn. Nothing technical, and about "
        "ten minutes to read.",
    )

    doc.add_heading("What this app is", level=1)
    body(
        doc,
        "Voucher Hunt is a game that ends in a real discount. You pick a shop or "
        "restaurant running a campaign, spin a roulette to reveal the voucher "
        "you have won, then book the date and time you will come in and use it. "
        "You show a QR code at the counter and the discount is yours. Alongside "
        "the hunt you collect Loyalty Points — LP — every day and on everything "
        "you buy, and you spend those points on rewards from any partner in the "
        "network.",
    )
    body(
        doc,
        "Everything happens in the Android app. There is no customer website to "
        "sign in to.",
        bold_lead="One thing to know up front. ",
    )

    doc.add_heading("What you need before you start", level=1)
    bullets(
        doc,
        [
            "An Android phone with the Voucher Hunt app installed.",
            "A Philippine mobile number that can receive SMS. This is how you sign in, and how your booking confirmation arrives.",
            "That is all. There is no password to create and no account form to fill in.",
        ],
    )

    # ---- Part 1 -----------------------------------------------------------
    doc.add_page_break()
    doc.add_heading("Part 1 — Signing in", level=1)
    body(
        doc,
        "You sign in once, and it covers the whole app — not once per campaign.",
    )

    step(doc, 1, "Enter your mobile number")
    body(
        doc,
        "Open the app and type your mobile number in the format 09XX XXX XXXX, "
        "then tap Send code.",
    )
    numbered(
        doc,
        [
            "Open the app.",
            "Tap the Mobile number field and type your number, for example 09171234567.",
            "Tap Send code.",
        ],
    )
    result_line(doc, "the screen changes to ask for a verification code.")
    shot(doc, "signin")

    step(doc, 2, "Type the six-digit code")
    body(
        doc,
        "We text you a six-digit code. Type it into the Verification code field "
        "and tap Verify and continue. Delivery can take up to a minute, so give "
        "it a moment before assuming it has failed.",
    )
    bullets(
        doc,
        [
            ("Nothing arrived? ", "Wait for the countdown on Resend code to finish, then tap it. You can also tap Change number if you mistyped."),
            ("Take care typing it. ", "After five wrong guesses the code stops working and you will need a new one."),
            ("Codes do not last forever. ", "If you leave the screen and come back much later, ask for a fresh code."),
        ],
    )
    result_line(doc, "you land on the Home tab and can start hunting.")

    # ---- Part 2 -----------------------------------------------------------
    doc.add_page_break()
    doc.add_heading("Part 2 — The five tabs", level=1)
    body(
        doc,
        "The bar along the bottom of the screen never changes. Here is what each "
        "tab is for, so the rest of this guide has somewhere to point.",
    )
    two_column_table(
        doc,
        [
            ("Home", "Every live campaign. Search or filter, then pick one to hunt."),
            ("Quests", "Today's missions, your level, and the badges you have earned."),
            ("Vouchers", "The vouchers you have won, and the QR code you show at the counter."),
            ("LP Shop", "Spend your Loyalty Points on rewards from partner businesses."),
            ("More", "Your Loyalty Points balance and wallet QR, your language, and your account."),
        ],
        headers=["Tab", "What it holds"],
    )

    # ---- Part 3 -----------------------------------------------------------
    doc.add_page_break()
    doc.add_heading("Part 3 — Hunting a voucher", level=1)
    body(
        doc,
        "This is the main thing the app does. Seven screens, start to finish.",
    )

    step(doc, 1, "Pick a campaign")
    body(
        doc,
        "The Home tab lists every campaign running now. Each card shows the "
        "business, the offer and the dates. Use the search box to look for a "
        "campaign, business or location, or use the filter row to narrow by "
        "category — Restaurant, Online Shop, Beauty, Pet, Retail, Other. Tap "
        "Hunt now on the one you want.",
    )
    shot(doc, "directory")

    step(doc, 2, "Start the hunt")
    body(
        doc,
        "The campaign page shows the offer and the rules. Read the two lines "
        "under the heading — they tell you that one spin reveals one voucher, "
        "and that higher discounts unlock fewer time slots. When you are ready, "
        "tap Let's Hunt!",
    )
    shot(doc, "campaign")

    step(doc, 3, "Spin the roulette")
    body(
        doc,
        "Every voucher in the campaign passes by on the reel. Tap Stop the reel "
        "whenever you feel lucky — the reel slows down and lands on your prize. "
        "Where it lands is decided fairly by the app, not by how fast you tap.",
    )
    result_line(doc, "the screen says Voucher unlocked! and names what you won.")
    shot(doc, "roulette")

    step(doc, 4, "Look at what you won")
    body(
        doc,
        "The results screen shows your voucher and what it is worth. Every "
        "voucher carries a rarity — Standard, Rare, Epic or Legendary — which is "
        "simply how hard it was to win. If you have an extra spin, you can use "
        "it here and choose between the results. When you are happy, tap Pick "
        "date & time.",
    )

    step(doc, 5, "Choose your date and time")
    body(
        doc,
        "Pick the day you will visit, then the time. Each time slot holds a set "
        "number of people; a slot that is full shows as Sold out, and one "
        "filling up warns you how many spots are left. Tap Continue.",
    )
    body(
        doc,
        "You will only be shown the times your particular voucher is valid at. "
        "A bigger discount is usually offered at fewer times — often the quieter "
        "ones. This is not a fault; it is how the businesses keep a deep "
        "discount affordable.",
        bold_lead="Why some times are missing. ",
    )
    shot(doc, "datetime")

    step(doc, 6, "Confirm your details")
    body(
        doc,
        "Enter the name the booking should be under, and the number of guests. "
        "Email is optional. Tap Confirm & Reserve.",
    )

    step(doc, 7, "Keep your voucher")
    body(
        doc,
        "You are done. The confirmation screen shows your voucher code and a QR "
        "code, and a confirmation SMS arrives with the discount, the date and "
        "the time. The voucher is also waiting for you in the Vouchers tab — you "
        "do not need to screenshot anything.",
    )
    result_line(doc, "the screen says You're all set! and shows a QR code.")
    shot(doc, "voucher")

    doc.add_heading("Three rules worth knowing", level=2)
    bullets(
        doc,
        [
            ("Your prize is drawn before you book. ", "The app decides what you won first, then offers you the times that prize is available at. This is why the date picker sometimes looks emptier than the campaign page suggested."),
            ("A hunt is resumed, never restarted. ", "If you close the app halfway through, reopening the campaign puts you back where you left off. An interrupted spin shows you the result you already earned rather than charging you another spin."),
            ("One voucher per campaign, per number. ", "Once you have confirmed a voucher for a campaign, that is your voucher for it. You can still hunt every other campaign."),
        ],
    )

    # ---- Part 4 -----------------------------------------------------------
    doc.add_page_break()
    doc.add_heading("Part 4 — Using your voucher in store", level=1)
    numbered(
        doc,
        [
            "Arrive within the time slot you booked.",
            "Open the Vouchers tab and tap your voucher.",
            "Tap Show QR code and hold the screen up for the staff to scan.",
            "They confirm it on their screen, and the discount is applied to your bill as normal.",
        ],
    )
    body(
        doc,
        "Your voucher stays valid until the end of the slot you booked. There is "
        "no separate countdown from when you won it — the booking is the deadline.",
        bold_lead="How long it lasts. ",
    )
    two_column_table(
        doc,
        [
            ("Active", "Won, booked, and not yet used. This is the one to show."),
            ("Redeemed", "Already used at the counter. It cannot be used again."),
            ("Expired", "The booked slot has passed without the voucher being used."),
        ],
        headers=["Voucher status", "What it means"],
    )
    body(
        doc,
        "If something comes up, ask the staff whether the campaign allows "
        "rescheduling — some do, and they can move your booking to another slot "
        "from their side. If you simply do not turn up, staff can mark the "
        "booking as a no-show.",
        bold_lead="If you cannot make it. ",
    )

    # ---- Part 5 -----------------------------------------------------------
    doc.add_page_break()
    doc.add_heading("Part 5 — Loyalty Points", level=1)
    body(
        doc,
        "Loyalty Points, or LP, are the app's second half. They work across every "
        "partner in the network, not just the shop you earned them at. Your "
        "balance, your daily earnings and your wallet QR all live in the More tab.",
    )
    shot(doc, "more")

    doc.add_heading("Four ways to earn", level=2)
    two_column_table(
        doc,
        [
            ("Open the app", "A random 1–10 LP, once a day."),
            ("Refer a friend", "10 LP when one new person opens your link, once a day."),
            ("Pay at a partner", "5% of what you spent. A ₱500 purchase earns you 25 LP."),
            ("Finish missions", "Some missions pay LP. See Part 6."),
        ],
        headers=["What you do", "What you get"],
    )
    body(
        doc,
        "Used every day, the daily rewards alone add up to as much as 600 LP over "
        "a month.",
    )

    doc.add_heading("Earning 5% at the counter", level=2)
    numbered(
        doc,
        [
            "Pay for your purchase as normal.",
            "Open the More tab and show the staff the wallet QR code on that screen.",
            "They scan it and enter what you paid.",
        ],
    )
    result_line(doc, "the new points appear on your balance in the More tab.")

    doc.add_heading("Spending your points", level=2)
    body(
        doc,
        "Open the LP Shop tab. You will find two kinds of reward:",
    )
    bullets(
        doc,
        [
            ("Partner items. ", "Pick a partner, pick an item, and buy it with points. It is kept under My items with a QR code you show at that partner's counter to collect it."),
            ("Global LP rewards. ", "A voucher you can use at any partner, redeemed from your Global LP balance. You need at least 50 LP to make one, and it is good for a year."),
        ],
    )
    body(
        doc,
        "Points you earn at a particular partner are held with that partner and "
        "shown separately in the shop. You can move them into your Global LP "
        "balance when you want to spend them somewhere else.",
        bold_lead="Two pockets. ",
    )
    body(
        doc,
        "You do not have to spend the whole thing at once — an LP voucher can be "
        "used against part of a bill, and what is left stays on it.",
        bold_lead="Part of a bill is fine. ",
    )
    shot(doc, "shop")

    # ---- Part 6 -----------------------------------------------------------
    doc.add_page_break()
    doc.add_heading("Part 6 — Quests, levels and badges", level=1)
    body(
        doc,
        "The Quests tab is the part of the app worth opening daily.",
    )

    doc.add_heading("Missions", level=2)
    body(
        doc,
        "Missions are small tasks that pay a reward — points, experience, or an "
        "extra hunt. There are two kinds, on two tabs:",
    )
    bullets(
        doc,
        [
            ("Daily. ", "A fresh set every day. The screen tells you what time today's missions reset."),
            ("Urgent. ", "Run by a partner, near you, for a limited time and a limited number of people. These show how long is left and how many places remain."),
        ],
    )
    body(
        doc,
        "Tap a mission to see what finishing it takes. When you have done it, tap "
        "Claim. Some urgent missions ask you to tap Join first, to hold your "
        "place, and some ask for evidence — usually a photo of your receipt. "
        "Someone at the partner checks that before the reward is paid, so those "
        "sit at Waiting for review for a while.",
    )
    shot(doc, "quests")

    doc.add_heading("Levels and XP", level=2)
    body(
        doc,
        "Experience — XP — decides your level, and there are five levels. Levels "
        "unlock things: bonus hunts each day, a head start on selected offers, "
        "and some partner offers that are open only from a certain level.",
    )
    body(
        doc,
        "XP is not LP, and the difference matters. LP is a balance you spend. XP "
        "only ever counts up, and cannot be spent, transferred, refunded or "
        "withdrawn. You turn LP into XP on the Level up screen — that spends the "
        "points and cannot be undone — but spending LP never costs you a level, "
        "because your level is worked out from all the XP you have ever earned.",
        bold_lead="The one rule to remember. ",
    )

    doc.add_heading("Achievements", level=2)
    body(
        doc,
        "Badges you keep for good. Each badge has tiers — Bronze, Silver, Gold "
        "and Royal — and each tier unlocks on its own as you go. They are grouped "
        "by what earns them: Hunt, Visit, Mission, Streak, Review, Referral, "
        "Explore and Points. You can pin your favourites as featured badges.",
    )

    # ---- Part 7 -----------------------------------------------------------
    doc.add_heading("Part 7 — Referrals", level=1)
    body(
        doc,
        "Sharing the app earns you two separate things.",
    )
    numbered(
        doc,
        [
            "Open the More tab and find the daily referral row.",
            "Tap Share and send the link however you like.",
            "When one new person opens it, you earn 10 LP — once a day.",
        ],
    )
    body(
        doc,
        "Separately, sharing your link during a hunt earns you an extra roulette "
        "spin when a friend opens it. The results screen shows how many extra "
        "spins you have earned today and the daily cap.",
        bold_lead="Extra spins. ",
    )

    # ---- Part 8 -----------------------------------------------------------
    doc.add_heading("Part 8 — Your account", level=1)
    body(doc, "All of this is in the More tab.")
    two_column_table(
        doc,
        [
            ("Your number", "Shown at the top, as Signed in as."),
            ("Language", "English, Korean, Chinese and Japanese."),
            ("About Voucher Hunt", "Opens the product page in your browser."),
            ("Sign out", "Ends the session on this phone. Your vouchers and points are safe and come back when you sign in again."),
            ("Delete my account", "Opens the account deletion page. This is permanent."),
        ],
        headers=["Setting", "What it does"],
    )

    # ---- Troubleshooting --------------------------------------------------
    doc.add_page_break()
    doc.add_heading("If something goes wrong", level=1)
    two_column_table(
        doc,
        [
            (
                "No code arrived",
                "Wait a full minute — delivery is not instant. Then use Resend code once the countdown ends. Check the number shown on screen is really yours; tap Change number if not.",
            ),
            (
                "The code is not accepted",
                "After five wrong tries a code is dead. Ask for a new one with Resend code and type it carefully.",
            ),
            (
                "Every time slot says Sold out",
                "Those are the slots for the prize you won, and they have filled up. Try another date, or another campaign.",
            ),
            (
                "No time slots at all",
                "The times for that prize are gone or not open yet. The campaign page is the place to check back.",
            ),
            (
                "The app says a hunt is already in progress",
                "You have a hunt part-finished on this number. Open the campaign again and it will put you back where you stopped.",
            ),
            (
                "Staff say the voucher is invalid",
                "Check you are inside the slot you booked and that the voucher still shows as Active. A Redeemed voucher has already been used.",
            ),
            (
                "My points did not go up after a purchase",
                "The 5% is added when staff scan your wallet QR from the More tab and enter the amount. If that was missed, ask at the counter.",
            ),
            (
                "I cannot make a Global LP voucher",
                "You need at least 50 LP in your Global LP balance. Points held at a partner have to be moved to Global first.",
            ),
        ],
        headers=["Problem", "What to do"],
    )

    # ---- Glossary ---------------------------------------------------------
    doc.add_heading("Words used in this guide", level=1)
    two_column_table(
        doc,
        [
            ("Campaign", "One business's offer, running between two dates, that you can hunt."),
            ("Hunt", "One run through a campaign: spin, win, book, confirm."),
            ("Slot", "A specific date and time window you book, with a limited number of places."),
            ("Rarity", "How hard a voucher was to win: Standard, Rare, Epic or Legendary."),
            ("LP (Loyalty Points)", "The balance you earn and spend across every partner."),
            ("Global LP", "The part of your balance that can be spent at any partner."),
            ("XP (experience)", "What decides your level. It counts up and can never be spent."),
            ("Mission", "A small task in the Quests tab that pays a reward."),
            ("Wallet QR", "The code in your More tab that staff scan to give you the 5%."),
        ],
        headers=["Term", "What it means"],
    )

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc.save(OUTPUT)
    embedded = sum(1 for key in SHOTS if (IMAGES / SHOTS[key][0]).exists())
    print(f"Wrote {OUTPUT.name} ({embedded}/{len(SHOTS)} screenshots embedded)")


if __name__ == "__main__":
    build()
