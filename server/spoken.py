"""Turn numbers into radio-friendly words (no symbols, no digits)."""
from decimal import ROUND_HALF_UP, Decimal

_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
         "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
         "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
_SCALES = [(10**9, "billion"), (10**6, "million"), (1000, "thousand")]

CENT = Decimal("0.01")


def int_words(n: int) -> str:
    if n < 0:
        return "minus " + int_words(-n)
    if n < 20:
        return _ONES[n]
    if n < 100:
        t, o = divmod(n, 10)
        return _TENS[t] + ("" if o == 0 else " " + _ONES[o])
    if n < 1000:
        h, r = divmod(n, 100)
        return _ONES[h] + " hundred" + ("" if r == 0 else " " + int_words(r))
    for scale, word in _SCALES:
        if n >= scale:
            q, r = divmod(n, scale)
            return int_words(q) + " " + word + ("" if r == 0 else " " + int_words(r))
    raise ValueError(n)


def money_words(amount: Decimal) -> str:
    amount = abs(Decimal(amount)).quantize(CENT, rounding=ROUND_HALF_UP)
    if amount < CENT:
        return "less than one cent"
    dollars = int(amount)
    cents = int((amount - dollars) * 100)
    parts = []
    if dollars:
        parts.append(f"{int_words(dollars)} dollar{'' if dollars == 1 else 's'}")
    if cents:
        parts.append(f"{int_words(cents)} cent{'' if cents == 1 else 's'}")
    return " and ".join(parts)


def price_words(price: Decimal) -> str:
    """Prices of 100 dollars or more are rounded to whole dollars for speech."""
    price = Decimal(price)
    if price >= 100:
        return money_words(price.quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    return money_words(price)
