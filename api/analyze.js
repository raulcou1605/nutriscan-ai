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

        // 1. Extraemos imageBase64, mimeType, healthProfile y el scanMode enviado desde el cliente
        const { imageBase64, mimeType, healthProfile, scanMode } = req.body;
        if (!imageBase64) {
            return res.status(400).json({ error: 'No se proporcionó ninguna imagen.' });
        }

        // Validación de seguridad: El modo plato preparado es estrictamente exclusivo para usuarios PRO
        if (scanMode === 'dish' && !profile.is_pro) {
            return res.status(403).json({ error: 'El modo de platos preparados es exclusivo para usuarios PRO.' });
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

        // Preparamos el objetivo del análisis según el modo seleccionado
        let analysisGoalText = "";
        if (scanMode === 'dish') {
            analysisGoalText = `Analiza este plato de comida preparado o menú de restaurante. Estima visualmente las porciones, calorías aproximadas y distribución de macronutrientes (Proteínas, Grasas, Carbohidratos).`;
        } else {
            analysisGoalText = `Analiza esta etiqueta o producto alimenticio empacado.`;
        }

        // 2. Preparamos el prompt personalizado si el usuario es PRO y configuró su perfil
        let personalizationPrompt = "";
        if (profile.is_pro && healthProfile) {
            personalizationPrompt = `
    
    CONTEXTO MÉDICO Y OBJETIVO DEL USUARIO (PRIORIDAD ALTA):
    - Objetivo nutricional: ${healthProfile.goal}
    - Alergias o restricciones estrictas: ${healthProfile.notes || "Ninguna especificada"}
    
    INSTRUCCIÓN ADICIONAL: Evalúa el contenido específicamente bajo este perfil. Si contiene alérgenos o contradice su objetivo (ej. exceso de carbohidratos para diabetes o sodio para hipertensión), refléjalo con claridad dentro del resumen o puntos de cuidado.`;
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
                                text: `${analysisGoalText} Devuelve EXCLUSIVAMENTE un objeto JSON válido (sin texto adicional, sin bloques de código markdown como \`\`\`) con esta estructura exacta:
{
  "name": "Nombre del platillo o producto",
  "category": "Categoría (ej. Comida Preparada, Ultraprocesado, Saludable)",
  "categoryClass": "bg-emerald-100 text-emerald-800",
  "score": 80,
  "scoreBg": "bg-emerald-500",
  "seals": ["Alto en Proteína", "Calorías Estimadas: ~450 kcal"],
  "harmful": [{"name": "Ingrediente o porción", "damage": "Efecto a considerar"}],
  "benefits": [{"text": "Punto nutricional favorable"}],
  "summary": "Resumen nutricional, calorías aproximadas y desglose de macros."
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

        // 3. Si el usuario es PRO, guardamos todos los detalles en el historial de Supabase
        if (profile.is_pro) {
            await supabase.from('scan_history').insert({
                user_id: user.id,
                product_name: analysis.name,
                category: analysis.category,
                score: analysis.score,
                summary: analysis.summary,
                seals: analysis.seals,
                harmful: analysis.harmful,
                benefits: analysis.benefits,
                category_class: analysis.categoryClass,
                score_bg: analysis.scoreBg
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
