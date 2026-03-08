"use client";

import { useEffect, useState } from "react";
import Tamagotchi from "./Tamagotchi";

interface Props {
  onComplete: () => void;
  userId?: string;
}

export default function WelcomeScreen({ onComplete, userId }: Props) {
  const [phase, setPhase] = useState<"enter" | "wave" | "exit">("enter");

  // Push state to server for Pi display sync
  const pushState = (s: string) => {
    if (!userId) return;
    fetch("/api/user/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: userId, state: s }),
    }).catch(() => {});
  };

  useEffect(() => {
    pushState("idle");
    const t1 = setTimeout(() => { setPhase("wave"); pushState("wave"); }, 800);
    const t2 = setTimeout(() => { setPhase("exit"); pushState("idle"); }, 3500);
    const t3 = setTimeout(() => onComplete(), 4300);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onComplete]);

  return (
    <div className="fixed inset-0 bg-black flex items-center justify-center">
      <div
        className={`transition-all duration-700 ${
          phase === "enter"
            ? "animate-fade-in"
            : phase === "exit"
              ? "opacity-0 scale-75"
              : ""
        }`}
        style={{
          width: "clamp(150px, 50vw, 55vh)",
          height: "clamp(150px, 50vw, 55vh)",
        }}
      >
        <Tamagotchi state={phase === "wave" ? "wave" : "idle"} userId={userId} />
      </div>
    </div>
  );
}
