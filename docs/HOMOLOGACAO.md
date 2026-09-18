# Roteiro de homologação

Usar contas e planejamentos de teste identificados, após aplicar o esquema e configurar Auth. Os testes automatizados nunca acessam o banco de produção.

1. Criar/confirmar a conta do PCP e executar bootstrap com o e-mail correto. Criar um operador de Risco e um de Corte. Antes da aprovação, verificar que não acessam cards. Aprovar no PCP.
2. Criar planejamento com todos os campos e quantidade apenas em 38, 40 e 42. Conferir número automático, data, soma e coluna Risco. Editar antes do primeiro rascunho e consultar as versões no histórico.
3. Entrar como Risco, salvar plotter/data inicial sem finalizar. Abrir novamente, completar os campos e alterar grade; conferir amarelo e histórico. Tentar data de ontem e quantidade negativa. Confirmar grade e finalizar.
4. Verificar que Risco não altera Corte. Entrar como Corte, salvar rascunho, conferir grade e finalizar. Abrir o mesmo card em duas sessões; salvar em uma e confirmar que a segunda recebe mensagem de versão desatualizada.
5. PCP preenche OP e data. Tentar repetir OP em outro card; verificar rejeição. Conferir horário de finalização automático no histórico.
6. Separação: grade somente leitura, costura externa exige oficina/previsão. Finalizar e verificar tag e dados da oficina. Repetir outro planejamento com costura interna.
7. Costura: entrada 100, saída 97, refugos 3, consertos 2 com descrição. Lavanderia: entrada 97, saída 95, refugos 2. Conferir refugo total 5, não 8. Verificar rejeição se saída + refugo difere da entrada, ou consertos excedem saída.
8. Finalizar Acabamento e Embalagem, conferir coluna Concluído e histórico de todas as etapas. Exportar histórico JSON.
9. Desativar um operador e confirmar que ele não lê a produção nem salva pela API. Cadastro de usuário não deve permitir escolher PCP. Um PCP não deve remover seu próprio acesso.
10. Testar confirmação de e-mail, recuperação de senha, logout, renovação de sessão, teclado, tela pequena, falha de rede e recarga. Cards reais nunca devem aparecer na demonstração pública.

Validações locais executadas: `pnpm test` (domínio + PostgreSQL/PGlite), `pnpm build` e revisão da interface no navegador. Registrar separadamente o resultado da homologação no Supabase hospedado.
