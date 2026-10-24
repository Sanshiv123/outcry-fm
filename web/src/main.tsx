import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { ApiError } from "./api.ts";
import { AppShell } from "./components/AppShell.tsx";
import { Activity } from "./pages/Activity.tsx";
import { AddFunds } from "./pages/AddFunds.tsx";
import { Station } from "./pages/Station.tsx";
import { Home } from "./pages/Home.tsx";
import { Send } from "./pages/Send.tsx";
import { SignIn } from "./pages/SignIn.tsx";
import { SignUp } from "./pages/SignUp.tsx";
import { Trade } from "./pages/Trade.tsx";
import { Rules } from "./pages/Rules.tsx";
import { Charts } from "./pages/Charts.tsx";
import { ConnectedWallet } from "./pages/ConnectedWallet.tsx";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failures, err) => !(err instanceof ApiError && err.status < 500) && failures < 2,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route index element={<Station />} />
          <Route path="/connected-wallet" element={<ConnectedWallet />} />
          <Route path="/signup" element={<SignUp />} />
          <Route path="/login" element={<SignIn />} />
          <Route element={<AppShell />}>
            <Route path="/wallet" element={<Home />} />
            <Route path="/trade" element={<Trade />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/charts" element={<Charts />} />
            <Route path="/add-funds" element={<AddFunds />} />
            <Route path="/send" element={<Send />} />
            <Route path="/activity" element={<Activity />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
