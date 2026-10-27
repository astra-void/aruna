// Reading static literals and object properties out of a definition object.
// Definitions are analyzed without executing the project, so anything a field
// needs must be a literal the compiler can see.

use oxc_ast::ast::{
    Expression, ObjectExpression, ObjectPropertyKind, PropertyKey,
};

pub(crate) fn property_name(key: &PropertyKey<'_>) -> Option<String> {
    match key {
        PropertyKey::StaticIdentifier(ident) => Some(ident.name.as_str().to_string()),
        PropertyKey::StringLiteral(literal) => Some(literal.value.to_string()),
        _ => None,
    }
}

pub(crate) fn is_function_like(expression: &Expression<'_>) -> bool {
    matches!(
        expression,
        Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)
    )
}

pub(crate) fn find_object_property<'a>(
    object: &'a ObjectExpression<'a>,
    name: &str,
) -> Option<&'a oxc_ast::ast::ObjectProperty<'a>> {
    object.properties.iter().find_map(|property| match property {
        ObjectPropertyKind::ObjectProperty(object_property) => {
            property_name(&object_property.key).and_then(|property_name| {
                if property_name == name {
                    Some(object_property.as_ref())
                } else {
                    None
                }
            })
        }
        ObjectPropertyKind::SpreadProperty(_) => None,
    })
}

pub(crate) fn positive_integer_from_numeric_literal(value: f64) -> Option<u32> {
    if !value.is_finite() || value <= 0.0 || value.fract() != 0.0 || value > u32::MAX as f64 {
        return None;
    }

    Some(value as u32)
}
