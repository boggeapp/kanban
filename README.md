# BOGGE · Kanban de produção

Aplicação web leve para confecção, em português, com interface em tons de jeans. Frontend estático no GitHub Pages; autenticação, autorização e dados no Supabase PostgreSQL.

## Executar

Node 24 e pnpm 11.19.0:

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm build
```

Abra `http://localhost:5173/kanban/`. A demonstração usa dados fictícios em memória e não grava no banco. Nenhum planejamento real é carregado sem autenticação e aprovação.

## Ativar o Supabase

1. Abra o projeto `glgvvywkhelpydodxajw` e execute `supabase/migrations/202609180001_kanban.sql` no SQL Editor. Execute uma única vez: é uma migração inicial transacional, não um script para recriar tabelas.
2. Em Authentication → URL Configuration, configure Site URL e Redirect URL como `https://boggeapp.github.io/kanban/`. Para desenvolvimento, adicione `http://localhost:5173/kanban/` e/ou `http://127.0.0.1:5173/kanban/`.
3. Mantenha confirmação de e-mail habilitada. Configure SMTP de produção para entrega de confirmação e recuperação de senha.
4. O primeiro administrador cria a própria conta pela aplicação e confirma o e-mail. Um administrador do projeto executa `supabase/bootstrap-admin.sql`, substituindo somente o e-mail indicado. Não envie senhas ou chaves secretas pelo chat nem as coloque no repositório.
5. Demais usuários criam suas contas; o PCP aprova e atribui perfis na tela **Usuários**. O cadastro nunca aceita um perfil administrativo enviado pelo navegador.

A chave `sb_publishable_...` usada na aplicação é pública por definição e não concede administração. Nenhuma chave `service_role`, senha de banco ou token de gerenciamento é necessária no frontend. URLs/chaves públicas podem ser sobrescritas pelas variáveis de `.env.example`.

## Publicar

O workflow `.github/workflows/pages.yml` executa testes, compila e publica cada push na branch `main`. Em Settings → Pages, selecione **GitHub Actions** como fonte. O endereço esperado é `https://boggeapp.github.io/kanban/`; a aplicação só estará operacional para produção depois da ativação do banco e do primeiro PCP.

## Regras implementadas

- Risco → Corte → PCP → Separação → Costura → Lavanderia → Acabamento → Embalagem → Concluído.
- Grade fixa de 19 tamanhos, total automático, inteiros não negativos e limite de 1 milhão por tamanho.
- Numeração sequencial no banco, começando por Bogge-001. Números nunca são reutilizados; lacunas podem ocorrer após transações revertidas.
- Criação e horários gerados no servidor. Comparação de datas no fuso `America/Sao_Paulo`.
- Datas novas não podem ser retroativas. Datas já salvas em rascunhos mantêm sua validade no dia seguinte; alterá-las exige novamente uma data válida.
- Rascunho mantém o card na coluna; **Finalizar** valida campos e conferência antes de avançar atomicamente. Não há arraste que burle validações.
- PCP administra usuários e opera todas as etapas. Planejamento cria cards. Operadores alteram exclusivamente sua etapa; usuários aprovados podem consultar o fluxo completo.
- Planejamento pode ser editado pelo criador antes de iniciar o Risco. O PCP também pode corrigir o planejamento nesse momento por possuir permissão administrativa total. Todas as versões ficam no histórico.
- Risco, Corte e PCP podem ajustar a grade. Separação só consulta. Costura em diante mostra a grade de entrada e a grade do Corte.
- Diferenças aparecem em amarelo. Histórico inclui autor, horário, dados, grades e versões anteriores, inclusive dos rascunhos.
- Na produção física, para cada tamanho, `entrada = saída + refugos`. Consertos são um subconjunto da saída. A mesma peça pode ter retrabalho em etapas diferentes: o painel mostra **ocorrências**, não peças únicas em conserto.
- Costura externa exige oficina e previsão, mostra uma tag e sinaliza atraso. Costura interna usa início/fim.
- OP é única; finalização do PCP é registrada pelo servidor.
- Google Drive deliberadamente fora desta versão. Uma futura integração poderá anexar digitalizações sem mudar o banco principal.

## Verificação

`pnpm test` roda testes de domínio e a migração real em PostgreSQL via PGlite, com papéis `anon`/`authenticated`, `auth.uid()` simulado e RLS habilitada. Verifica negações de acesso, promoção indevida, transições, conservação de quantidades, histórico, datas, duplicidade de OP e conflito de versão. Não substitui a homologação da autenticação, SMTP e migração no Supabase hospedado.

Consulte [a análise completa da arquitetura](docs/ARQUITETURA.md) e [o roteiro de homologação](docs/HOMOLOGACAO.md).
