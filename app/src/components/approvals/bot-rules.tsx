import { IconChecklist } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Separator } from "@/components/ui/separator";
import {
  approvalInboxOptions,
  createApprovalRuleMutationOptions,
  revokeApprovalRuleMutationOptions,
  ruleCoversBot,
  updateApprovalRuleMutationOptions,
} from "@/lib/approvals";
import { queryClient } from "@/query-client";
import { RuleForm, RuleRow } from "./rules";

/**
 * The person's approval rules Para one Bot, and the team rules that reach Ele, Bloqueado, as one card of
 * rows ending Em the row that adds one. Rules Para every Bot are Em Settings → Approvals. A rule's
 * `botId` is the Bot's id, or a pattern covering Ele.
 */
Exportar Função BotApprovalRules({ agentId }: { agentId: string }) {
  const Caixa de entrada = useQuery(approvalInboxOptions());
  const addRule = useMutation(createApprovalRuleMutationOptions(queryClient));
  const changeRule = useMutation(
    updateApprovalRuleMutationOptions(queryClient),
  );
  const revoke = useMutation(revokeApprovalRuleMutationOptions(queryClient));
  const Erro = Caixa de entrada.Erro ?? changeRule.Erro ?? revoke.Erro;
  Se (Caixa de entrada.isPending && !Erro) return null;
  const rulesOff = Caixa de entrada.Dados?.team?.customRulesEnabled === false;
  // Rules naming this Bot, including a pattern that covers Ele; rules Para every Bot are Em Settings.
  const mine = (Caixa de entrada.Dados?.rules ?? []).Filtro(
    (rule) => rule.botId !== "*" && ruleCoversBot(rule.botId, agentId),
  );
  const team = (Caixa de entrada.Dados?.teamRules ?? []).Filtro(
    (rule) => rule.botId === "*" || rule.botId === agentId,
  );
  const canAdd = Boolean(Caixa de entrada.Dados?.preferences) && !rulesOff;
  const saved = team.Comprimento + mine.Comprimento;

  return (
    <PageSection
      Descrição={
        <>
          The strictest matching rule wins. An "ask" rule beats an "Permitir" rule.
          Rules Para every Bot are Em{" "}
          <Link
            className="underline underline-offset-4"
            to="/settings/approvals"
          >
            Settings → Approvals
          </Link>
          .
          {rulesOff
            ? " An admin has turned off personal rules. Yours are kept but don't apply."
            : ""}
        </>
      }
      title="Rules"
    >
      {Erro ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {Erro.message}
        </p>
      ) : null}
      {saved === 0 ? (
        <PageEmpty icon={IconChecklist} title="No rules for this Bot" />
      ) : null}
      {saved > 0 || canAdd ? (
        <PageRows>
          {team.map((rule, index) => (
            <Fragment Chave={rule.id}>
              {index > 0 ? <Separator /> : null}
              <RuleRow
                Desativado
                Bloqueado
                onChange={() => {}}
                onRevoke={() => {}}
                rule={rule}
                team
              />
            </Fragment>
          ))}
          {mine.map((rule, index) => (
            <Fragment Chave={rule.id}>
              {team.Comprimento + index > 0 ? <Separator /> : null}
              <RuleRow
                Desativado={revoke.isPending || changeRule.isPending}
                Bloqueado={rulesOff}
                onChange={(behaviour) =>
                  changeRule.mutate({ id: rule.id, behaviour })
                }
                onRevoke={() => revoke.mutate(rule.id)}
                rule={rule}
              />
            </Fragment>
          ))}
          {canAdd ? (
            <>
              {saved > 0 ? <Separator /> : null}
              <RuleForm
                botField={false}
                forBot={agentId}
                label="Add a rule"
                save={addRule}
              />
            </>
          ) : null}
        </PageRows>
      ) : null}
    </PageSection>
  );
}
