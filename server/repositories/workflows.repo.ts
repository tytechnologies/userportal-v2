// Workflow repository — reads from deal_workflows/deal_workflow_steps and
// proxies RPC calls. Mirrors the pattern in server/repositories/deals.repo.ts.
//
// All callers must pass an H3 event for serverSupabaseClient(event) to
// pick up the user's session. RLS does the auth lifting on reads;
// SECURITY DEFINER RPCs do it on writes.

import type { H3Event } from 'h3'
import { serverSupabaseClient } from '#supabase/server/serverSupabaseClient'

export type WorkflowStep = {
  id: string
  step_index: number
  key: string
  title: string
  description: string | null
  phase: string
  attestation_text: string
  status: 'locked' | 'active' | 'completed' | 'skipped'
  document_id: string | null
  attested_at: string | null
  attested_by: string | null
  attestation_signature: string | null
  completed_at: string | null
  skip_reason: string | null
}

export type Workflow = {
  id: string
  deal_id: string
  template_id: string | null
  template_key: string
  title_branch: 'condo' | 'land' | null
  status: 'active' | 'completed' | 'abandoned'
  current_step_id: string | null
  started_via: 'envelope_auto' | 'manual'
  envelope_id: string | null
  started_by: string | null
  started_at: string
  completed_at: string | null
  abandoned_at: string | null
  abandon_reason: string | null
  steps: WorkflowStep[]
}

export const workflowsRepo = {
  /** Returns the deal's workflow + ordered step list, or null if no workflow exists. */
  async getByDealId({ event, dealId }: { event: H3Event; dealId: string }): Promise<Workflow | null> {
    const supabase = await serverSupabaseClient(event)
    const { data: wf, error } = await (supabase as any)
      .from('deal_workflows')
      .select('*')
      .eq('deal_id', dealId)
      .maybeSingle()
    if (error) throw error
    if (!wf) return null

    const { data: steps, error: stepsErr } = await (supabase as any)
      .from('deal_workflow_steps')
      .select('*')
      .eq('workflow_id', wf.id)
      .order('step_index')
    if (stepsErr) throw stepsErr

    return { ...(wf as Workflow), steps: (steps ?? []) as WorkflowStep[] }
  },

  async start({
    event, dealId, templateKey, titleBranch, startedVia, envelopeId,
  }: {
    event: H3Event
    dealId: string
    templateKey: string
    titleBranch: 'condo' | 'land' | null
    startedVia: 'envelope_auto' | 'manual'
    envelopeId: string | null
  }): Promise<string> {
    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any).rpc('deal_workflow_start', {
      p_deal_id: dealId,
      p_template_key: templateKey,
      p_title_branch: titleBranch,
      p_started_via: startedVia,
      p_envelope_id: envelopeId,
    })
    if (error) throw error
    return data as string
  },

  async advance({
    event, stepId, documentId, attestationSignature,
  }: {
    event: H3Event
    stepId: string
    documentId: string
    attestationSignature: string
  }): Promise<string | null> {
    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any).rpc('deal_workflow_advance', {
      p_step_id: stepId,
      p_document_id: documentId,
      p_attestation_signature: attestationSignature,
    })
    if (error) throw error
    return (data ?? null) as string | null
  },

  async abandon({
    event, workflowId, reason,
  }: {
    event: H3Event
    workflowId: string
    reason: string
  }): Promise<string> {
    const supabase = await serverSupabaseClient(event)
    const { data, error } = await (supabase as any).rpc('deal_workflow_abandon', {
      p_workflow_id: workflowId,
      p_reason: reason,
    })
    if (error) throw error
    return data as string
  },
}
