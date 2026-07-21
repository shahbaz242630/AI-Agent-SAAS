"use client";

import { useEffect, useState } from "react";
import type { HealthResponse } from "@eva/types";

type BadgeState =
  { kind: "loading" } | { kind: "healthy"; health: HealthResponse } | { kind: "unreachable" };

/**
 * Shows live API connectivity by polling the api health endpoint.
 * Proves the web → api path end-to-end in Slice 0.1; reused on the
 * dashboard shell in later slices.
 */
export function HealthBadge() {
  const [state, setState] = useState<BadgeState>({ kind: "loading" });

  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

    fetch(`${apiUrl}/health`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`health check failed: ${res.status}`);
        const health = (await res.json()) as HealthResponse;
        setState({ kind: "healthy", health });
      })
      .catch(() => setState({ kind: "unreachable" }));
  }, []);

  if (state.kind === "loading") {
    return <span className="text-muted-foreground">Checking API…</span>;
  }

  if (state.kind === "unreachable") {
    return (
      <span className="text-danger">
        API unreachable — automation continues in the cloud once connected.
      </span>
    );
  }

  return (
    <span className="text-success">
      API connected · {state.health.service} v{state.health.version}
    </span>
  );
}
