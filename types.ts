
export type CallState = 'idle' | 'ringing' | 'active' | 'ended';

export interface TranscriptionTurn {
  speaker: 'user' | 'ai';
  text: string;
}
