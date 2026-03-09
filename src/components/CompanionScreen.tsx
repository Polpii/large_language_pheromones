"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Tamagotchi from "./Tamagotchi";

interface Props {
  deviceId: string;
}

export default function CompanionScreen({ deviceId }: Props) {
  const [state, setState] = useState<
    "idle" | "listening" | "processing" | "dating"
  >("idle");
  const [transcript, setTranscript] = useState("");
  const [response, setResponse] = useState("");
  const [textInput, setTextInput] = useState("");
  const [showInput, setShowInput] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Push state to server so the Pi display stays in sync
  const pushState = useCallback(
    (s: string) => {
      fetch("/api/user/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, state: s }),
      }).catch(() => {});
    },
    [deviceId]
  );

  // Map internal state to tamagotchi state name and push
  const setAndPush = useCallback(
    (s: "idle" | "listening" | "processing" | "dating") => {
      setState(s);
      const tamaMap: Record<string, string> = {
        idle: "idle",
        listening: "listen",
        processing: "think",
        dating: "dating",
      };
      pushState(tamaMap[s] || s);
    },
    [pushState]
  );

  const processInput = useCallback(
    async (text: string) => {
      setAndPush("processing");
      setTranscript(text);
      try {
        const res = await fetch("/api/listen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceId, text }),
        });
        const data = await res.json();

        if (data.action === "dating") {
          setAndPush("dating");
          setResponse("");
          const matchRes = await fetch("/api/agents/date", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceId, query: data.query }),
          });
          const matchData = await matchRes.json();
          setResponse(matchData.summary || "Done!");
          setTimeout(() => {
            setResponse("");
            setTranscript("");
            setAndPush("idle");
          }, 3000);
        } else {
          setResponse(data.message || "Updated!");
          setTimeout(() => {
            setResponse("");
            setTranscript("");
            setAndPush("idle");
          }, 3000);
        }
      } catch {
        setResponse("Something went wrong.");
        setTimeout(() => {
          setResponse("");
          setAndPush("idle");
        }, 2000);
      }
    },
    [deviceId]
  );

  const startListening = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setShowInput(true);
      return;
    }

    setAndPush("listening");
    setTranscript("");
    setResponse("");

    const recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      const text = Array.from(event.results)
        .map((r: SpeechRecognitionResult) => r[0].transcript)
        .join("");
      setTranscript(text);
      if (event.results[0].isFinal) {
        processInput(text);
      }
    };

    recognition.onerror = () => setAndPush("idle");
    recognition.onend = () => {
      if (stateRef.current === "listening") setAndPush("idle");
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [processInput]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setAndPush("idle");
  }, [setAndPush]);

  // L key handler - trigger on keyup to prevent repeat
  useEffect(() => {
    let pressed = false;
    const downHandler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if ((e.key === "l" || e.key === "L") && !pressed) {
        pressed = true;
      }
    };
    const upHandler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if ((e.key === "l" || e.key === "L") && pressed) {
        pressed = false;
        if (stateRef.current === "idle") startListening();
        else if (stateRef.current === "listening") stopListening();
      }
    };
    window.addEventListener("keydown", downHandler);
    window.addEventListener("keyup", upHandler);
    return () => {
      window.removeEventListener("keydown", downHandler);
      window.removeEventListener("keyup", upHandler);
    };
  }, [startListening, stopListening]);

  // A key handler — display art.png on the Pi screen for 30s
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "a" || e.key === "A") {
        pushState("art");
      }
    };
    window.addEventListener("keydown", handler, { once: true });
    // re-register after each press
    const reRegister = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "a" || e.key === "A") {
        window.addEventListener("keydown", handler, { once: true });
      }
    };
    window.addEventListener("keyup", reRegister);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("keyup", reRegister);
    };
  }, [pushState]);

  const handleTextSubmit = () => {
    if (!textInput.trim()) return;
    setShowInput(false);
    processInput(textInput.trim());
    setTextInput("");
  };

  const tamaState =
    state === "listening"
      ? "listen"
      : state === "dating"
        ? "dating"
        : state === "processing"
          ? "think"
          : "idle";

  return (
    <div className="fixed inset-0 bg-black flex flex-col items-center justify-center overflow-y-auto">
      <div
        style={{
          width: "clamp(150px, 50vw, 55vh)",
          height: "clamp(150px, 50vw, 55vh)",
        }}
      >
        <Tamagotchi state={tamaState} userId={deviceId} />
      </div>

      {/* Status */}
      {state === "listening" && (
        <p className="text-cyan-400 text-xs mt-4 animate-pulse">
          Listening...
        </p>
      )}

      {state === "processing" && (
        <p className="text-cyan-400 text-xs mt-4 animate-pulse">
          Thinking...
        </p>
      )}

      {/* Transcript */}
      {transcript && state !== "idle" && (
        <p className="text-white/50 text-xs mt-2 max-w-[80vw] text-center">
          &ldquo;{transcript}&rdquo;
        </p>
      )}

      {/* Response */}
      {response && (
        <p className="text-cyan-400 text-xs mt-2 max-w-[80vw] text-center">
          {response}
        </p>
      )}

      {/* Text input fallback */}
      {showInput && (
        <div className="mt-4 flex gap-2 px-4 max-w-[85vw] w-full">
          <input
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleTextSubmit()}
            className="flex-1 bg-white/5 text-white text-xs px-3 py-2 rounded-full outline-none border border-white/10 focus:border-cyan-500"
            placeholder="Type here..."
            autoFocus
          />
          <button
            onClick={handleTextSubmit}
            className="shrink-0 w-8 h-8 rounded-full bg-cyan-700 text-white text-xs flex items-center justify-center"
          >
            →
          </button>
        </div>
      )}

      {/* Hint */}
      {state === "idle" && !response && (
        <p className="text-white/15 text-xs mt-8">Press L to talk</p>
      )}

      {/* Text toggle */}
      {state === "idle" && !showInput && (
        <button
          onClick={() => setShowInput(true)}
          className="text-white/10 text-xs mt-2 hover:text-white/30 transition-colors"
        >
          or type
        </button>
      )}
    </div>
  );
}
