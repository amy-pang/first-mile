import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Simulation } from './sim';

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

  async saveRun(sim: Simulation): Promise<string | null> {
    if (!this.user) return 'Not signed in';
    const bd = sim.breakdown();
    const get = (key: string) => bd.find((c) => c.key === key)?.got ?? 0;
    const flags = sim.marks.map((m) => m.title).join(', ');
    const { error } = await supabase.from('drives').insert({
      overall_score: sim.score,
      right_of_way: get('yield'),
      speed_control: get('speed'),
      following_dist: get('following'),
      lane_pos_steer: get('lane'),
      signals_checks: get('signals'),
      blind_spots: get('blind'),
      additional_flags: flags,
    });
    return error?.message ?? null;
  }
}
