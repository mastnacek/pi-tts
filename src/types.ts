export type VaderProfile = "classic" | "vader2" | "vader3" | "c3po";

export interface TtsConfig {
	enabled: boolean;
	backend: "edge" | "native";
	voice: string;
	rate: string;
	pitch: string;
	vader: boolean;
	vaderProfile: VaderProfile;
	/** Extra Vader pitch shift in semitones; null = per-backend default. */
	vaderDepth: number | null;
	prosody: boolean;
	maxLen: number;
}
