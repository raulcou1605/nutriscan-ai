const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const groqApiKey = process.env.GROQ_API_KEY;

module.exports = async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Método no permitido' });
    }

    try {
        if (!supabaseUrl || !supabaseAnonKey || !groqApiKey) {
            return res.status(500).json({ error: 'Faltan variables de entorno en Vercel.' });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Sesión inválida o expirada.' });
        }

        const token = authHeader.split(' ')[1];
        const supabase = createClient(supabaseUrl, supabaseAnonKey, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });

        const { data: { user }, error: userError } = await supabase.auth.getUser(token);
        if (userError || !user) {
            return res.status(401).json({ error: 'Usuario no autenticado.' });
        }

        let { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .maybeSingle();

        if (!profile) {
            const { data: newProfile, error: createError } = await supabase
                .from('profiles')
                .upsert([{ id: user.id, is_pro: false, scans_today: 0 }])
                .select()
                .single();
            
            if (createError) {
                return res.status(500).json({ error: 'Error al inicializar el perfil en la base de datos: ' + createError.message });
            }
            profile = newProfile;
        }

        if (!profile.is_pro) {
            const today = new Date().toISOString().split('T')[0];
            const lastScanDate = profile.last_scan_date ? profile.last_scan_date.split('T')[0] : '';
            let scansToday = profile.scans_today || 0;

            if (lastScanDate !== today) {
                scansToday = 0;
            }

            if (scansToday >= 3) {
                return res.status(429).json({ error: 'Límite diario alcanzado', scans_today: scansToday });
            }

            await supabase
                .from('profiles')
                .update({ 
                    scans_today: scansToday + 1, 
                    last_scan_date: new Date().toISOString() 
                })
                .eq('id', user.id);
            
            profile.scans_today = scansToday + 1;
        }

        // 1. Extraemos imageBase64, mimeType y el healthProfile enviado desde el cliente
        const { imageBase64, mimeType, healthProfile } = req.body;
        if (!imageBase64) {
            return res.status(400).json({ error: 'No se proporcionó ninguna imagen.' });
        }

        // 2. Preparamos el prompt personalizado si el usuario es PRO y configuró su perfil
        let personalizationPrompt = "";
        if (profile.is_pro && healthProfile) {
            personalizationPrompt = `
    
    CONTEXTO MÉDICO Y OBJETIVO DEL USUARIO (PRIORIDAD ALTA):
    - Objetivo nutricional: ${healthProfile.goal}
    - Alergias o restricciones estrictas: ${healthProfile.notes || "Ninguna especificada"}
    
    INSTRUCCIÓN ADICIONAL: Evalúa la tabla nutrimental e ingredientes específicamente bajo este perfil. Si el producto contiene algún alérgeno mencionado o contradice su objetivo (ej. alto sodio para hipertensión, alto azúcar para diabetes), refléjalo con claridad dentro del resumen o puntos de cuidado.`;
        }

        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${groqApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'qwen/qwen3.8-27b',
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: `Analiza esta etiqueta o producto alimenticio. Devuelve EXCLUSIVAMENTE un objeto JSON válido (sin texto adicional, sin bloques de código markdown como \`\`\`) con esta estructura exacta:
{
  "name": "Nombre del producto",
  "category": "Categoría (ej. Ultraprocesado, Saludable, Bebida)",
  "categoryClass": "bg-red-100 text-red-800",
  "score": 75,
  "scoreBg": "bg-amber-500",
  "seals": ["Exceso Sodio", "Exceso Azúcares"],
  "harmful": [{"name": "Ingrediente", "damage": "Efecto negativo"}],
  "benefits": [{"text": "Punto favorable"}],
  "summary": "Resumen breve del análisis general."
}${personalizationPrompt}`
                            },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}`
                                }
                            }
                        ]
                    }
                ],
                temperature: 0.2,
                max_tokens: 800
            })
        });

        const groqData = await groqResponse.json();
        if (!groqResponse.ok) {
            return res.status(500).json({ error: groqData.error?.message || 'Error en Groq API.' });
        }

        let rawContent = groqData.choices[0].message.content.trim();
        rawContent = rawContent.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
        
        const analysis = JSON.parse(rawContent);

        // 3. Si el usuario es PRO, guardamos automáticamente en el historial de Supabase
        if (profile.is_pro) {
            await supabase.from('scan_history').insert({
                user_id: user.id,
                product_name: analysis.name,
                category: analysis.category,
                score: analysis.score,
                summary: analysis.summary
            });
        }

        return res.status(200).json({
            success: true,
            analysis,
            is_pro: profile.is_pro,
            scans_today: profile.scans_today
        });

    } catch (err) {
        console.error('Error crítico:', err);
        return res.status(500).json({ error: err.message || 'Error interno en el servidor.' });
    }
};
