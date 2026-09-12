/* Pure syscall/state-machine mocks: no fork, namespace, signals or workload. */
#define FREEDOM_OWNER_TEST
#include "linux-supervisor.c"
#include <assert.h>

struct mock { struct owner *owner; int sends, observes, reaps, observe_result, reap_result, send_error;
    struct terminal observed, reaped; int step, fail_at; };
static int send_mock(void *ctx, int fd) {
    struct mock *m=ctx; assert(fd==42); assert(!m->owner->retired); m->sends++; return m->send_error;
}
static int observe_mock(void *ctx, int fd, struct terminal *t) {
    struct mock *m=ctx; assert(fd==42); m->observes++; *t=m->observed; return m->observe_result;
}
static int reap_mock(void *ctx, int fd, struct terminal *t) {
    struct mock *m=ctx; assert(fd==42); assert(m->owner->retired); m->reaps++; *t=m->reaped; return m->reap_result;
}
static bool step(void *ctx) { struct mock *m=ctx; m->step++; return m->step!=m->fail_at; }
static const struct operations ops={send_mock,observe_mock,reap_mock};
static const struct handoff_ops hops={step,step,step,step};
int main(void) {
    unsigned cases=0;
    for (int fail=0; fail<=2; fail++) {
        struct mock parent={.fail_at=fail};
        assert(arm_parent(&hops,&parent)==(fail==0));
        assert(parent.step==(fail?fail:2)); cases++;
    }
    {
        struct owner wire={.created=true,.armed=true,.ready=true};
        assert(accept_control(&wire,'G')); assert(!accept_control(&wire,'A'));
        assert(wire.released && !strcmp(wire.reason,"cancelled")); cases++;
    }
    for (int stage=0; stage<5; stage++) {
        struct owner wire={.created=stage>=1,.armed=stage>=2,.ready=stage>=3,.released=stage>=3};
        assert(!accept_control(&wire,stage==4?'?':'G'));
        assert(!strcmp(wire.reason,"protocol_error")); cases++;
    }
    for (int stage=0; stage<4; stage++) {
        struct owner o={.created=stage>=1,.armed=stage>=2,.ready=stage>=3,.pidfd=42};
        request_stop(&o,"cancelled"); assert(!release_allowed(&o));
        struct mock m={.owner=&o}; cleanup_signal(&o,&ops,&m);
        assert(m.sends==(stage>=1)); cases++;
    }
    for (int fail=0; fail<=5; fail++) {
        struct mock m={.fail_at=fail};
        assert(handoff(&hops,&m)==(fail==0));
        assert(m.step==(fail?fail:5)); cases++;
    }
    for (int code=0; code<=1; code++) {
        struct owner o={.created=true,.armed=true,.ready=true,.pidfd=42};
        assert(release_allowed(&o)); o.released=true; assert(!release_allowed(&o));
        request_stop(&o,"cancelled"); request_stop(&o,"timed_out");
        struct mock m={.owner=&o,.observe_result=1,.reap_result=1,.observed={code,0},.reaped={code,0}};
        cleanup_signal(&o,&ops,&m); observe_and_reap(&o,&ops,&m);
        cleanup_signal(&o,&ops,&m); observe_and_reap(&o,&ops,&m);
        assert(o.reaped && o.observed && o.retired && !o.uncertain && o.actual.code==code);
        assert(!strcmp(o.reason,"cancelled") && m.sends==1 && m.reaps==1); cases++;
    }
    for (int error=0; error<4; error++) {
        struct owner o={.created=true,.pidfd=42};
        struct mock m={.owner=&o,.observe_result=error==0?0:error==1?-ECHILD:1,
            .reap_result=error==2?-ECHILD:1,.observed={0,0},.reaped={1,0}};
        observe_and_reap(&o,&ops,&m);
        if (!error) { assert(!o.observed && !o.retired); cleanup_signal(&o,&ops,&m); assert(m.sends==1); }
        else { assert(o.uncertain && o.retired); cleanup_signal(&o,&ops,&m); assert(m.sends==0); }
        cases++;
    }
    struct owner o={.created=true,.pidfd=42}; struct mock m={.owner=&o,.send_error=EPERM};
    cleanup_signal(&o,&ops,&m); assert(o.uncertain && !o.retired);
    cleanup_signal(&o,&ops,&m); assert(m.sends==2); cases++;
    printf("PASS %u finite native state/handoff cases; no native workloads\n",cases);
    return 0;
}
