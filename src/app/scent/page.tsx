"use client";

import { useState, useEffect, useCallback } from "react";

interface ScentItem {
  scent_name: string;
  scent_duration: number;
}

interface Recipe {
  userId: string;
  description: string;
  scent_sequence: ScentItem[];
  justification: string;
  createdAt: string;
}

interface DeviceStatus {
  bridge: { running: boolean; playing?: boolean };
  device: { connected: boolean; address?: string; message?: string };
}

interface PlaySequenceItem {
  scent_id: number;
  duration: number;
}

// Scent name → location mapping for display
const SCENT_LOCATIONS: Record<string, number> = {
  "geosmin 1%": 1, "garlic": 2, "sage": 3, "patchouli": 4,
  "lavanda ess france": 5, "oregano": 6, "myrth": 7, "holy basil": 8,
  "tangerine": 9, "whisper bond": 10, "serene embrace": 11, "strawberry": 12,
};

// Color per scent for visual flair
const SCENT_COLORS: Record<string, string> = {
  "geosmin 1%": "#8B7355", "garlic": "#F5DEB3", "sage": "#9DC183",
  "patchouli": "#6B4226", "lavanda ess france": "#B57EDC", "oregano": "#556B2F",
  "myrth": "#C19A6B", "holy basil": "#228B22", "tangerine": "#FFA500",
  "whisper bond": "#DDA0DD", "serene embrace": "#87CEEB", "strawberry": "#FF6B81",
};

export default function ScentPage() {
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null); // userId being played
  const [generating, setGenerating] = useState<string | null>(null);
  const [playResult, setPlayResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/scent/status");
      const data = await res.json();
      setStatus(data);
    } catch {
      setStatus(null);
    }
  }, []);

  const fetchRecipes = useCallback(async () => {
    try {
      const res = await fetch("/api/scent/recipe");
      const data = await res.json();
      setRecipes(data.recipes || []);
    } catch {
      setRecipes([]);
    }
  }, []);

  useEffect(() => {
    Promise.all([fetchStatus(), fetchRecipes()]).then(() => setLoading(false));
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus, fetchRecipes]);

  const handleConnect = async () => {
    setConnecting(true);
    setPlayResult(null);
    try {
      const res = await fetch("/api/scent/connect", { method: "POST" });
      const data = await res.json();
      setStatus(data);
    } catch {
      await fetchStatus();
    }
    setConnecting(false);
  };

  const handlePlay = async (userId: string) => {
    setPlaying(userId);
    setPlayResult(null);
    try {
      const res = await fetch("/api/scent/play", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json();
      if (data.status === "playing") {
        setPlayResult({ ok: true, msg: `Playing ${userId}'s scent (${data.totalDuration}s)` });
      } else {
        setPlayResult({ ok: false, msg: data.error || "Failed to play" });
        setPlaying(null);
      }
    } catch (e) {
      setPlayResult({ ok: false, msg: e instanceof Error ? e.message : "Error" });
      setPlaying(null);
    }
  };

  const handleGenerate = async (userId: string) => {
    setGenerating(userId);
    try {
      await fetch("/api/scent/recipe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      await fetchRecipes();
    } catch { /* */ }
    setGenerating(null);
  };

  // Check if device is actively playing (from bridge status polling)
  const isDevicePlaying = status?.bridge?.playing || false;

  // Clear playing state when device stops
  useEffect(() => {
    if (!isDevicePlaying && playing) {
      const timer = setTimeout(() => setPlaying(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [isDevicePlaying, playing]);

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-white/50 text-lg animate-pulse">Loading scent system...</div>
      </div>
    );
  }

  const bridgeRunning = status?.bridge?.running ?? false;
  const deviceConnected = status?.device?.connected ?? false;

  return (
    <div className="min-h-screen bg-black text-white p-6">
      {/* Header */}
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-1 tracking-tight">
          Pheromones
        </h1>
        <p className="text-white/40 text-sm mb-8">Scent device control & recipe manager</p>

        {/* Connection Status Panel */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-5 mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Device Status</h2>
            <button
              onClick={handleConnect}
              disabled={connecting}
              className="px-4 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm transition-colors disabled:opacity-50"
            >
              {connecting ? "Scanning..." : bridgeRunning ? "Scan Device" : "Start Bridge"}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Bridge */}
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full ${bridgeRunning ? "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.5)]" : "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.5)]"}`} />
              <div>
                <div className="text-sm font-medium">BLE Bridge</div>
                <div className="text-xs text-white/40">{bridgeRunning ? "Running on port 5050" : "Not running"}</div>
              </div>
            </div>

            {/* Device */}
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full ${deviceConnected ? "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.5)]" : "bg-yellow-400 shadow-[0_0_8px_rgba(250,204,21,0.5)]"}`} />
              <div>
                <div className="text-sm font-medium">Scent Device</div>
                <div className="text-xs text-white/40">
                  {deviceConnected
                    ? `Connected (${status?.device?.address || ""})`
                    : (status?.device?.message || "Not found — make sure it's powered on")}
                </div>
              </div>
            </div>
          </div>

          {/* Playing indicator */}
          {(isDevicePlaying || playing) && (
            <div className="mt-4 flex items-center gap-3 p-3 rounded-lg bg-purple-500/10 border border-purple-500/20">
              <div className="flex gap-1">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    className="w-1 bg-purple-400 rounded-full animate-pulse"
                    style={{
                      height: `${12 + Math.sin(i * 1.2) * 8}px`,
                      animationDelay: `${i * 0.15}s`,
                    }}
                  />
                ))}
              </div>
              <span className="text-sm text-purple-300 flex-1">
                {playing ? `Playing ${playing}'s pheromone...` : "Device is playing a scent..."}
              </span>
              <button
                onClick={async () => {
                  await fetch("/api/scent/stop", { method: "POST" });
                  setPlaying(null);
                  setPlayResult({ ok: true, msg: "Playback stopped" });
                  fetchStatus();
                }}
                className="px-3 py-1 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-300 text-sm font-medium transition-colors border border-red-500/30"
              >
                Stop
              </button>
            </div>
          )}
        </div>

        {/* Play result toast */}
        {playResult && (
          <div
            className={`mb-6 p-3 rounded-lg text-sm ${playResult.ok ? "bg-green-500/10 border border-green-500/20 text-green-300" : "bg-red-500/10 border border-red-500/20 text-red-300"}`}
          >
            {playResult.msg}
          </div>
        )}

        {/* Recipes */}
        <h2 className="text-lg font-semibold mb-4">Scent Recipes ({recipes.length})</h2>

        {recipes.length === 0 ? (
          <div className="text-center text-white/30 py-12">
            No recipes yet. Create users first, then their scent recipes will be generated automatically.
          </div>
        ) : (
          <div className="space-y-4">
            {recipes.map((recipe) => (
              <RecipeCard
                key={recipe.userId}
                recipe={recipe}
                isPlaying={playing === recipe.userId}
                isDevicePlaying={isDevicePlaying}
                deviceConnected={deviceConnected}
                onPlay={() => handlePlay(recipe.userId)}
                onRegenerate={() => handleGenerate(recipe.userId)}
                isRegenerating={generating === recipe.userId}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RecipeCard({
  recipe,
  isPlaying,
  isDevicePlaying,
  deviceConnected,
  onPlay,
  onRegenerate,
  isRegenerating,
}: {
  recipe: Recipe;
  isPlaying: boolean;
  isDevicePlaying: boolean;
  deviceConnected: boolean;
  onPlay: () => void;
  onRegenerate: () => void;
  isRegenerating: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const totalDuration = recipe.scent_sequence.reduce((s, i) => s + i.scent_duration, 0);

  return (
    <div
      className={`rounded-xl border transition-colors ${isPlaying ? "border-purple-500/40 bg-purple-500/5" : "border-white/10 bg-white/5"}`}
    >
      {/* Header row */}
      <div className="p-4 flex items-center gap-4">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex-1 flex items-center gap-3 text-left"
        >
          <div className="text-xl">{isPlaying ? "🎵" : "🧴"}</div>
          <div className="flex-1">
            <div className="font-semibold">{recipe.userId}</div>
            <div className="text-xs text-white/40">
              {recipe.scent_sequence.length} scents · {totalDuration}s ·{" "}
              {new Date(recipe.createdAt).toLocaleDateString()}
            </div>
          </div>
          {/* Scent sequence timeline mini-bar */}
          <div className="flex h-5 rounded overflow-hidden w-40">
            {recipe.scent_sequence.map((item, i) => (
              <div
                key={i}
                className="h-full"
                title={`${item.scent_name} (${item.scent_duration}s)`}
                style={{
                  width: `${(item.scent_duration / totalDuration) * 100}%`,
                  backgroundColor: SCENT_COLORS[item.scent_name] || "#666",
                  opacity: 0.8,
                }}
              />
            ))}
          </div>
        </button>

        <div className="flex gap-2">
          <button
            onClick={onRegenerate}
            disabled={isRegenerating}
            className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs transition-colors disabled:opacity-50"
            title="Regenerate recipe"
          >
            {isRegenerating ? "⏳" : "🔄"}
          </button>
          <button
            onClick={onPlay}
            disabled={!deviceConnected || isDevicePlaying}
            className="px-4 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-sm font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {isPlaying ? "Playing..." : "▶ Play"}
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-white/5 p-4">
          {/* Scent sequence detail */}
          <div className="space-y-2 mb-4">
            {recipe.scent_sequence.map((item, idx) => (
              <div key={idx} className="flex items-center gap-3">
                <div
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: SCENT_COLORS[item.scent_name] || "#666" }}
                />
                <div className="flex-1 text-sm">
                  <span className="font-medium">{item.scent_name}</span>
                  <span className="text-white/40 ml-2">slot {SCENT_LOCATIONS[item.scent_name] || "?"}</span>
                </div>
                <div className="text-sm text-white/50 tabular-nums">{item.scent_duration}s</div>
                <div className="w-24 h-2 bg-white/5 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(item.scent_duration / 30) * 100}%`,
                      backgroundColor: SCENT_COLORS[item.scent_name] || "#666",
                      opacity: 0.7,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Justification */}
          <div className="text-xs text-white/30 leading-relaxed">
            <span className="text-white/50 font-medium">Justification: </span>
            {recipe.justification}
          </div>
        </div>
      )}
    </div>
  );
}
