"""Danish names for stored staff role and contract codes.

Every pay document a revisor reads (wage CSV, payroll PDF, lønseddel) prints
these instead of the raw codes ("kitchen", "hourly"). Unknown codes print as
stored.
"""

PAY_ROLE_DA = {
    "manager": "Leder", "kitchen": "Køkken", "chef": "Kok", "cook": "Kok",
    "server": "Tjener", "waiter": "Tjener", "bar": "Bar", "bartender": "Bartender",
    "barista": "Barista", "host": "Vært", "runner": "Runner", "dishwasher": "Opvasker",
    "cleaner": "Rengøring", "floor": "Sal",
}
PAY_CONTRACT_DA = {
    "full": "Fuldtid", "full_time": "Fuldtid", "full-time": "Fuldtid",
    "part": "Deltid", "part_time": "Deltid", "part-time": "Deltid",
    "hourly": "Timeløn", "student": "Studerende", "trainee": "Elev", "intern": "Praktikant",
}


def role_da(code) -> str:
    return PAY_ROLE_DA.get(str(code or "").strip().lower(), str(code or ""))


def contract_da(code) -> str:
    return PAY_CONTRACT_DA.get(str(code or "").strip().lower(), str(code or ""))
