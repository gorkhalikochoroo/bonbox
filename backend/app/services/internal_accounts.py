"""
Internal (non-adopter) accounts — the single source of truth.

WHY THIS IS NOT IN scripts/. It was, and both the thesis export and the fleet
metrics need it. A router importing from backend/scripts/ works only by
implicit-namespace-package luck (scripts/ has no __init__.py), inverts the
app -> scripts dependency direction, and drags SessionLocal in at import time.
It also invites the two consumers to drift, which would mean the thesis and the
product could report different populations from the same database.

Excluding is a documented decision, not a silent trim. Every id below was
read from prod on 16 Jul 2026 and falls in ONE of three unarguable classes:
founder/operator accounts, internal @bonbox.dk accounts (seed/QA/App-Store
review), or explicit test/example/security-probe signups. Excluding these is
not a judgement call — none is an external adopter.

DELIBERATELY *NOT* excluded here (they need a human call, logged separately in
the thesis reflexivity journal, NOT hidden in code):
  • geography — most organic signups read as Nepali diaspora, not DK-operating
    businesses; the speciale is a DK study, so the DK-only frame is a scoping
    decision Manoj owns, not a silent WHERE-clause.
  • ~5 throwaway/curiosity signups (disposable-domain emails, junk business
    names like "x"/"helloworld"/"asfasgfa"). Real-ish addresses; excluding
    them is a data-quality judgement, so it stays visible, not auto-applied.
"""

EXCLUDED_ACCOUNTS: dict[str, str] = {
    # founder / operator accounts (not external adopters)
    "3436a646-b458-4321-96fc-49ac108bd2f3": "founder — super_admin, Manoj's own admin account",
    "c9fd58ff-9509-4178-bec9-1b6abdeddee8": "founder — Manoj's own dev/test account ('Iron Side', pro-granted)",
    "c167ae4f-2081-406f-87b9-1f90aa9ae8bb": "internal demo — business_name 'BonBox Demo', pro manually granted, not an organic signup",
    # internal @bonbox.dk (seed / QA / App Store review)
    "d55dec95-5f51-4133-826b-1135f90c9e68": "internal — test@bonbox.dk ('Test Cafe')",
    "e217a63a-fed1-4d97-858a-7fbcd064cd0a": "internal — demo@bonbox.dk (the 'Copenhagen Street Burger' demo seed)",
    "f2b9b009-3c7b-43b0-a519-31db0e0a1bbd": "internal — review@bonbox.dk (App Store review account)",
    "fb55d09f-8022-4b52-b3d5-c5fb89d585f0": "internal — testt@bonbox.dk",
    "b835052e-07d5-4162-b7d9-7d4f36ca9988": "internal — test.staff@bonbox.dk (staff-flow QA)",
    "15546e46-33cb-4c02-aefc-d4bf5796df3b": "internal — appstore@bonbox.dk (App Store review account)",
    "089027f9-b555-4f07-bb22-6dfa472138d9": "internal — aappstore@bonbox.dk (App Store review account)",
    # explicit test / QA / security-probe accounts
    "29f0df13-a266-46c9-9df5-0e9166489a4f": "test — 'OnRender Test' deploy-smoke account",
    "a3bbad6b-5ac2-46d5-adc7-b1ad26b695e0": "test — testnepal99@test.com",
    "c1c814ca-f9f6-4f49-b43e-ec4250cf2bf3": "test — testnepal_check2@test.com",
    "35a00127-717d-4e68-a768-f630cac4ad5b": "test — test@example.com",
    "747c8926-d32c-4b5c-bbf5-eb0a5fa96278": "test — testbot_deploy@test.com (deploy bot)",
    "940b4ee1-4241-472a-b352-8c6c7edf829b": "test — newuser@example.com",
    "9ba0399b-2836-4895-aa06-a232925d4c6f": "test — test_fixed@example.com",
    "861d8079-5cc4-4d2d-8353-ea46daa098c9": "test — test-auth-check@test.com (auth QA)",
    "7e71d1e5-a42d-4cee-bce5-e0ed614f9a79": "security probe — bonbox-probe.com (pentest harness)",
    "79ebcc0d-153b-4bdb-abf2-c623d0c8a3bd": "security probe — bonbox-probe.com (pentest harness)",
    "4055e6be-01fe-4551-8fb6-7f4034d09386": "security probe — bonbox-probe.com spoof test (pentest harness)",
}
