// Script de teste para validar loja.js
// Simula diferentes cenários de acesso

const SCENARIOS = {
  scenario1: {
    name: "✅ Acesso válido: Usuário logado é dono da loja",
    storeSlug: "manto-dez-sports",
    userLoggedIn: true,
    userId: "8a4cc84b-cec5-4d51-9cca-90915f7b3d79",
    storeOwnerId: "8a4cc84b-cec5-4d51-9cca-90915f7b3d79",
    expectedResult: "PASS - ADMIN_LOJA_ID definido"
  },

  scenario2: {
    name: "❌ Acesso negado: Usuário logado NÃO é dono da loja",
    storeSlug: "manto-dez-sports",
    userLoggedIn: true,
    userId: "different-user-id-123",
    storeOwnerId: "8a4cc84b-cec5-4d51-9cca-90915f7b3d79",
    expectedResult: "BLOCK - 'Acesso negado' message displayed"
  },

  scenario3: {
    name: "🔄 Redirect: Usuário NÃO está logado",
    storeSlug: "manto-dez-sports",
    userLoggedIn: false,
    userId: null,
    storeOwnerId: "8a4cc84b-cec5-4d51-9cca-90915f7b3d79",
    expectedResult: "REDIRECT - /admin.html?return=<encoded-url>"
  },

  scenario4: {
    name: "❌ Store not found: Slug inválido",
    storeSlug: "loja-inexistente",
    userLoggedIn: true,
    userId: "8a4cc84b-cec5-4d51-9cca-90915f7b3d79",
    storeOwnerId: null,
    expectedResult: "BLOCK - 'Loja não encontrada' message displayed"
  },

  scenario5: {
    name: "⚠️ Legacy store: Loja sem user_id (antiga)",
    storeSlug: "katalogo-hub",
    userLoggedIn: true,
    userId: "qualquer-usuario",
    storeOwnerId: null,
    expectedResult: "PASS - ADMIN_LOJA_ID definido (acesso permitido para qualquer logado)"
  }
};

console.log("📋 Cenários de Teste para loja.js");
console.log("==================================\n");

Object.entries(SCENARIOS).forEach(([key, scenario]) => {
  console.log(`${scenario.name}`);
  console.log(`  Slug: ${scenario.storeSlug}`);
  console.log(`  User: ${scenario.userLoggedIn ? scenario.userId : "NOT_LOGGED_IN"}`);
  console.log(`  Store Owner: ${scenario.storeOwnerId || "NONE"}`);
  console.log(`  ✓ Esperado: ${scenario.expectedResult}`);
  console.log("---");
});

console.log("\n📝 Como testar:");
console.log("1. Acesse https://katalogohub.com/loja/manto-dez-sports/");
console.log("2. Verifique o console.log (F12) para ver os logs de validação");
console.log("3. Confirm que o window.ADMIN_LOJA_ID está definido quando apropriado");
console.log("4. Teste cada cenário mudando de usuário/store");
