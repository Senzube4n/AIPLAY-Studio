import {randomUUID} from 'node:crypto';

/** Transport-only metadata, authenticated by a short-lived server-owned token.
 * Request JSON can never supply batch lineage, stage overrides or payment consent. */
export function createBatchMusicBridge({submit}) {
  const contexts=new Map();
  const requests=new WeakMap();
  return {
    metadata(req) {
      const token=req.headers?.['x-aiplay-batch-call'];
      if (typeof token!=='string') return {};
      const context=contexts.get(token);
      if (!context) throw new Error('This overnight submission expired before it could queue.');
      requests.set(req,context);
      return context.metadata;
    },
    beforeQueue(req) {
      const context=requests.get(req);
      if ((req.headers?.['x-aiplay-batch-call'] && !context) || (context && contexts.get(context.token)!==context)) throw new Error('This overnight submission expired before it could queue.');
    },
    record(req,job) {const context=requests.get(req);if(context) context.job=job;},
    async enqueue({batchId,stages,actor,paidConfirmed,...request}) {
      const token=randomUUID();
      const context={token,metadata:{batchId,stages:{...stages},paidConfirmed:paidConfirmed===true},job:null};
      contexts.set(token,context);
      try {
        const billable=(request.engine ?? 'minimax-music3')==='minimax-music3';
        const result=await submit('/api/generate', {...request,...(billable && paidConfirmed===true ? {confirmSpend:true} : {})},actor,
          {'x-aiplay-batch-call':token});
        if (!result.job?.id) throw new Error('Studio did not acknowledge an overnight song.');
        return result.job;
      } catch(error) {
        // Recording is synchronous with enqueue, before writing the HTTP reply.
        // Lost acknowledgements therefore return the owned job instead of duplicating it.
        if (context.job) return context.job;
        contexts.delete(token);
        // A revoked token cannot queue later, even after slow cover preparation.
        error.definitelyNotQueued=true;
        throw error;
      } finally {contexts.delete(token);}
    },
  };
}
