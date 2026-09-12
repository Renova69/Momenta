export type ReactionKind = 'heart' | 'clap' | 'cheers' | 'laugh' | 'party';

export interface LiveReaction {
  id: string;
  reaction: ReactionKind;
  guestName: string | null;
}

export type ReactionListener = (reaction: LiveReaction) => void;
