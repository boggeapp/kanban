# Evolução de OPs e produção parcial — 02/10/2026

## Comportamento

**Desmembrar OP:** o PCP abre um card cuja Costura terminou, antes de iniciar a Lavanderia. Informa quantas novas OPs deseja criar e, para cada uma, o **número criado no ERP**, a **referência**, a **descrição** e a grade por tamanho. Referência e descrição vêm preenchidas com os dados atuais e podem ser alteradas. Não há geração automática de sufixos A/B/C nem integração de criação no ERP.

A OP original mantém seu número, referência, descrição e histórico, e continua ativa na Lavanderia com o saldo restante. Cada nova OP deve receber peças; a OP original deve manter ao menos uma peça. Em cada tamanho, `saldo anterior = saldo da OP atual + soma das novas OPs`. Exemplo: OP 123 com 100 peças → 40 permanecem na OP 123, 35 vão para OP 900 e 25 para OP 901. Números informados não podem repetir a OP atual, outra nova OP ou uma OP já existente, inclusive excluída.

É possível criar de 1 a 100 novas OPs por operação e repetir o desmembramento da OP original enquanto a Lavanderia não tiver sido iniciada. OPs derivadas não podem ser desmembradas novamente. Histórico e refugos anteriores não são copiados aos filhos, evitando duplicação. Desmembramentos da versão anterior permanecem intactos: a atualização não renomeia OPs nem redistribui peças já registradas.

**Liberar parcela pronta:** em Acabamento ou Embalagem, o operador autorizado informa a grade pronta, refugos, consertos e datas da parcela. A parcela avança em um novo card; o saldo permanece na etapa. As parcelas mantêm a OP e recebem identificadores `1`, `2` etc.; uma parcela novamente fracionada recebe `1.1`, `1.2` etc. Cada card tem também seu número Bogge único. Para cada tamanho:

`saldo anterior = peças prontas + refugos desta liberação + saldo restante`

Consertos pertencem às peças prontas, nunca são outra baixa. Exemplo: de 100 peças, liberar 30 com 2 refugos deixa 68 no card original e envia 30 ao próximo estágio. O botão **Finalizar** continua concluindo o saldo inteiro. Ao distribuir todo o saldo em parcelas, a origem sai do quadro ativo e permanece no filtro de distribuídos. Datas de início anteriormente salvas continuam válidas; datas novas obedecem à regra não retroativa.

**Voltar etapa:** somente PCP, com motivo e confirmação. Restaura a grade de entrada da etapa selecionada. Registros dessa etapa e posteriores são arquivados integralmente, deixando de compor os totais atuais, e ficam visíveis no histórico/exportação. A etapa retornada deve ser preenchida novamente. O número da OP continua reservado. Uma parcela pode retornar até a etapa em que nasceu; uma OP desmembrada, até Lavanderia. Cards com destinos vinculados não podem retornar, mesmo que algum destino esteja excluído: restaurar o saldo anterior duplicaria peças já distribuídas.

**Excluir card:** somente PCP, com motivo e confirmação. Exclusão lógica, restaurável no filtro **Excluídos**. Não apaga grades, registros, auditoria nem libera a numeração da OP. O card e seus registros deixam dos totais atuais. Excluir um destino não devolve suas peças à origem. Cards com destinos não podem ser excluídos; o PCP opera os destinos individualmente. Exclusão é cancelamento administrativo, não refugo físico: perdas reais devem ser lançadas na etapa.

## Análise crítica e proteção das funções existentes

| Risco | Proteção adotada | Limite operacional |
| --- | --- | --- |
| Somar a origem e seus destinos como peças ativas | No desmembramento ERP, origem conserva somente o saldo; containers antigos e totalmente distribuídos ficam fora do quadro padrão | Cards distribuídos exibem quantidades históricas, não estoque atual |
| Baixar o mesmo refugo várias vezes | Registros anteriores não são copiados aos filhos; parcelas consomem apenas seu saldo | Indicador de consertos continua medindo ocorrências, não peças distintas |
| Voltar etapa e recriar peças já enviadas | Retorno bloqueado na origem com filhos; piso de retorno por lote | Não há junção automática de OPs/parcelas |
| Apagar histórico ao corrigir uma etapa | Arquivo imutável da linha original e evento com autor/motivo | Totais operacionais refletem a versão vigente, não a soma de todas as versões |
| Dois operadores liberarem o mesmo saldo | Bloqueio da linha e versão obrigatória, tudo em uma transação | Tela desatualizada exige reabrir o card |
| Criar somente parte dos filhos após erro | Desmembramento integralmente transacional, inclusive conflito de OP | Sequências podem ter lacunas após rollback, como já acontecia |
| Liberar data retroativa por meio de parcela | Reutiliza a finalização existente; só preserva data já salva | Não copia o rascunho de quantidades antigas ao saldo restante |
| Burlar permissões pelo navegador | RLS, tabelas somente leitura para clientes, RPCs com validação de perfil | Chave pública continua sem acesso administrativo |
| Editar planejamento depois de retorno ao Risco | Bloqueio quando há registros arquivados ou origem derivada | Planejamento original permanece auditável |
| Comparar um lote pequeno com o corte inteiro | Grade do lote como entrada; link explícito para origem e corte original | Não rateia o corte original artificialmente entre lotes |
| Migração danificar produção existente | Migrações incrementais; a revisão ERP substitui apenas a função de desmembramento, sem regravar cards existentes | Precisa aplicar a migração uma única vez |

O fluxo anterior, autenticação, criação de usuários, 19 tamanhos, destaques amarelos, costura externa, rascunhos e validação de campos continuam usando os mesmos mecanismos. Google Drive continua fora do escopo. O banco mantém as versões anteriores das funções **privadas**, sem permissão de execução para clientes, para reutilizar a lógica validada sem permitir bypass.

## Implantação e recuperação

1. Executar testes e build. Publicar o frontend; ele reconhece a presença das colunas novas e não mostra operações novas antes da migração.
2. Aplicar as migrações pendentes na ordem: `202610020001_production_lots.sql` e depois `202610020002_erp_split.sql`. Se a primeira já foi aplicada, executar **somente a segunda**. Não repetir a migração inicial. A revisão ERP altera a função, preservando integralmente cards e históricos existentes. Frontends antigos que enviam somente grades são rejeitados: precisam recarregar para informar os números do ERP.
3. Conferir colunas, funções, RLS e contagens antes/depois. Recarregar abas do sistema para carregar a versão publicada.
4. Se uma operação falhar, a transação reverte todos os seus efeitos. Não reaplicar migração já concluída. Não remover colunas/funções para tentar desfazer uma operação real. Usar restauração/retorno quando permitidos, mantendo o histórico.

Abas antigas não entendem os novos containers. As rotinas do servidor impedem gravações nesses cards, mas a equipe deve recarregar o site antes de usar parcelas. A atualização não automatiza backup externo, SMTP ou autenticação de usuários.

## Evidências de verificação

`node --test tests/*.test.js`: testes de domínio e SQL real em PostgreSQL/PGlite, incluindo migração sobre dados existentes, fluxo antigo completo, RLS, papéis, datas, conservação por tamanho, conflitos de OP e versão, rollback do desmembramento, parcelas em ambas as etapas, retorno e restauração. Esses testes não substituem carga simultânea em PostgreSQL hospedado nem validação de entrega de e-mails.

`node tests/ui-preview.mjs`: prévia local em `http://127.0.0.1:5174/kanban/`, com o módulo de API substituído por dados fictícios e gravações bloqueadas. Permite conferir os formulários reais sem acessar o Supabase. Não integra o bundle de produção.
