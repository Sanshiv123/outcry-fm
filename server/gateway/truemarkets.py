"""Real True Markets Gateway adapter — STUBS ONLY until verified.

Deliberately not implemented: we do not guess request/response shapes, signing,
or asset IDs. Fill each method from the Gateway docs and Tensho's code.

Candidate operations from the official Python SDK (`pip install truemarkets`,
https://pypi.org/project/truemarkets/), to be confirmed:
  gateway: compute_quote, create_order, execute_order, get_order_status,
           create_transfer, execute_transfer, get_transfer, list_assets, get_balances
  defi:    create_wallet, get_history, get_balances
  signing: client.sign_turnkey(payload) on each payload returned by create_order,
           then execute_order(id, signatures=..., auth_type=API_KEY)

Rules for whoever implements this:
  - Raise GatewayError when the Gateway definitely rejected the request.
  - Raise GatewayUncertain(ref_id=...) on timeouts / dropped connections after submit.
    Never retry an order or transfer submission inside this adapter.
  - Never log request bodies, signatures or key material.
"""
from __future__ import annotations

from .base import GatewayBackend  # noqa: F401  (interface reference)


class TrueMarketsGateway:
    simulated = False

    def __init__(self, wallet_model: str, station_wallet_address: str | None):
        if wallet_model not in {"org_custodial", "user_account"}:
            raise ValueError("WALLET_MODEL must be org_custodial or user_account")
        self.wallet_model = wallet_model
        self.station_wallet_address = station_wallet_address

    def _todo(self, what: str):
        raise NotImplementedError(f"TrueMarketsGateway.{what}: verify against Gateway docs / Tensho first")

    async def create_wallets(self, user_id):
        self._todo("create_wallets")

    async def get_prices(self, symbols):
        self._todo("get_prices")

    async def get_price_history(self, symbol, range_):
        self._todo("get_price_history")

    async def get_balances(self, user):
        self._todo("get_balances")

    async def get_quote(self, user, symbol, side, usd_amount):
        self._todo("get_quote")

    async def place_order(self, user, quote, client_ref):
        self._todo("place_order")

    async def get_order_status(self, user, order_id):
        self._todo("get_order_status")

    async def transfer_to_station(self, user, symbol, qty, client_ref):
        self._todo("transfer_to_station")

    async def fund_from_station(self, user, symbol, qty, client_ref):
        self._todo("fund_from_station")

    async def get_transfer_status(self, user, transfer_id):
        self._todo("get_transfer_status")
