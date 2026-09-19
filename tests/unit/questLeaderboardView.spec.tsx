import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import React from 'react';

import { QuestLeaderboard } from '../../src/components/quests/QuestLeaderboard';
import { QuestLeaderboardEntry } from '../../src/types';
import { i18n } from '../../src/i18n';

/**
 * The list a guest checks between photos: who leads, and where they stand.
 * The server has already ranked it; this only decides what fits on a phone
 * and keeps the viewer's own row in sight.
 */

afterEach(cleanup);

function ranked(count: number): QuestLeaderboardEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    rank: i + 1,
    guestId: `g${i + 1}`,
    name: `Guest ${i + 1}`,
    avatarUrl: null,
    points: 100 - i,
    questsCompleted: 1,
    questIds: [],
  }));
}

const names = () => screen.getAllByRole('listitem').map((li) => within(li).queryByText(/^Guest \d+/)?.textContent ?? '...');

describe('QuestLeaderboard', () => {
  it('renders nothing while the first fetch is in flight', () => {
    const { container } = render(<QuestLeaderboard entries={null} />);

    // Not the empty state: "no points yet" would be a claim about the event.
    expect(container).toBeEmptyDOMElement();
  });

  it('invites the first photo while nobody has scored', () => {
    render(<QuestLeaderboard entries={[]} />);

    expect(screen.getByText(i18n.t('leaderboard.empty'))).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it("shows the server's order, with each guest's points", () => {
    render(<QuestLeaderboard entries={ranked(3)} />);

    expect(names()).toEqual(['Guest 1', 'Guest 2', 'Guest 3']);
    expect(within(screen.getAllByRole('listitem')[0]).getByText('100')).toBeInTheDocument();
  });

  it('shows only the top rows a phone has room for', () => {
    render(<QuestLeaderboard entries={ranked(15)} limit={10} />);

    expect(names()).toHaveLength(10);
    expect(screen.queryByText('Guest 11')).toBeNull();
  });

  it('marks the viewer where they already appear', () => {
    render(<QuestLeaderboard entries={ranked(5)} currentGuestId="g2" limit={10} />);

    const current = screen.getAllByRole('listitem').filter((li) => li.getAttribute('aria-current') === 'true');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain('Guest 2');
    expect(within(current[0]).getByText(i18n.t('leaderboard.you'))).toBeInTheDocument();
    expect(names()).toHaveLength(5);
  });

  it('pins the viewer below the list when they are further down', () => {
    render(<QuestLeaderboard entries={ranked(15)} currentGuestId="g13" limit={10} />);

    const rows = names();
    // Ten rows, then the viewer, still showing their true rank. The gap
    // between them is decoration and hidden from assistive technology.
    expect(rows).toHaveLength(11);
    expect(rows[10]).toMatch(/^Guest 13/);
    expect(within(screen.getAllByRole('listitem')[10]).getByText('13')).toBeInTheDocument();
  });

  it('shows everyone to the host, who has to know who won', () => {
    render(<QuestLeaderboard entries={ranked(15)} hint="host hint" />);

    expect(names()).toHaveLength(15);
    expect(screen.getByText('host hint')).toBeInTheDocument();
  });
});
