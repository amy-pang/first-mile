import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Simulation } from './sim';

export interface DriveRun {
  id: string;
  created_at: string;
  overall_score: number;
  right_of_way: number;
  speed_control: number;
  following_dist: number;
  lane_pos_steer: number;
  signals_checks: number;
  blind_spots: number;
  additional_flags: string;
  /** Whether the driver reached their assigned exit. Older rows may not have this. */
  reached_end?: boolean | null;
}

export class AuthManager {
  user: User | null = null;
  onUserChange: ((user: User | null) => void) | null = null;

  async init(): Promise<void> {
    const { data: { session } } = await supabase.auth.getSession();
    this.user = session?.user ?? null;

    supabase.auth.onAuthStateChange((_event, session) => {
      this.user = session?.user ?? null;
      this.onUserChange?.(this.user);
    });
  }

  async signUp(email: string, password: string): Promise<string | null> {
    const { error } = await supabase.auth.signUp({ email, password });
    return error?.message ?? null;
  }

  async signIn(email: string, password: string): Promise<string | null> {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error?.message ?? null;
  }

  async signOut(): Promise<void> {
    await supabase.auth.signOut();
  }

  async fetchRuns(): Promise<{ runs: DriveRun[]; error: string | null }> {
    if (!this.user) return { runs: [], error: null };
    const { data, error } = await supabase
      .from('drives')
      .select('id, created_at, overall_score, right_of_way, speed_control, following_dist, lane_pos_steer, signals_checks, blind_spots, additional_flags, reached_end')
      .order('created_at', { ascending: false });
    return { runs: (data ?? []) as DriveRun[], error: error?.message ?? null };
  }

  async saveRun(sim: Simulation): Promise<string | null> {
    if (!this.user) return 'Not signed in';
    const bd = sim.breakdown();
    const get = (key: string) => bd.find((c) => c.key === key)?.got ?? 0;
    const flags = sim.marks.map((m) => m.title).join(', ');
    // "Reached end" means the driver drove out an exit (state 'done'); a crash leaves state 'crashed'.
    const reachedEnd = sim.state === 'done';
    const { error } = await supabase.from('drives').insert({
      overall_score: sim.score,
      right_of_way: get('yield'),
      speed_control: get('speed'),
      following_dist: get('following'),
      lane_pos_steer: get('lane'),
      signals_checks: get('signals'),
      blind_spots: get('blind'),
      additional_flags: flags,
      reached_end: reachedEnd,
    });
    return error?.message ?? null;
  }
}
