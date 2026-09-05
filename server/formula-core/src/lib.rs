//! Small, deterministic numeric formula language used by the extension.
//!
//! This crate intentionally has no Attricat host dependency. The event handler
//! and preview command both supply already-authorized, context-resolved values.

use std::collections::{BTreeSet, HashMap};

#[derive(Debug, Clone, PartialEq)]
pub enum FormulaError {
    InvalidSyntax { position: usize, message: String },
    UnknownAttribute(String),
    MissingValue(String),
    DivisionByZero,
}

impl std::fmt::Display for FormulaError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidSyntax { position, message } => {
                write!(
                    formatter,
                    "Invalid formula at character {position}: {message}"
                )
            }
            Self::UnknownAttribute(attribute) => {
                write!(formatter, "Unknown attribute `{attribute}`.")
            }
            Self::MissingValue(attribute) => write!(
                formatter,
                "Attribute `{attribute}` has no value in this context."
            ),
            Self::DivisionByZero => write!(formatter, "Cannot divide by zero."),
        }
    }
}

impl std::error::Error for FormulaError {}

#[derive(Debug, Clone, PartialEq)]
pub struct Formula {
    root: Expression,
}

#[derive(Debug, Clone, PartialEq)]
enum Expression {
    Number(f64),
    Attribute(String),
    UnaryMinus(Box<Expression>),
    Binary {
        operator: Operator,
        left: Box<Expression>,
        right: Box<Expression>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Operator {
    Add,
    Subtract,
    Multiply,
    Divide,
}

impl Formula {
    pub fn parse(expression: &str) -> Result<Self, FormulaError> {
        let mut parser = Parser::new(expression);
        let root = parser.expression()?;
        parser.skip_whitespace();
        if !parser.at_end() {
            return Err(parser.error("expected an operator"));
        }
        Ok(Self { root })
    }

    pub fn dependencies(&self) -> Vec<String> {
        let mut dependencies = BTreeSet::new();
        self.root.collect_dependencies(&mut dependencies);
        dependencies.into_iter().collect()
    }

    /// Evaluate with attribute-code keyed values that have already been resolved
    /// by Attricat for one requested context.
    pub fn evaluate(&self, values: &HashMap<String, Option<f64>>) -> Result<f64, FormulaError> {
        self.root.evaluate(values)
    }
}

impl Expression {
    fn collect_dependencies(&self, dependencies: &mut BTreeSet<String>) {
        match self {
            Self::Attribute(attribute) => {
                dependencies.insert(attribute.clone());
            }
            Self::UnaryMinus(expression) => expression.collect_dependencies(dependencies),
            Self::Binary { left, right, .. } => {
                left.collect_dependencies(dependencies);
                right.collect_dependencies(dependencies);
            }
            Self::Number(_) => {}
        }
    }

    fn evaluate(&self, values: &HashMap<String, Option<f64>>) -> Result<f64, FormulaError> {
        match self {
            Self::Number(value) => Ok(*value),
            Self::Attribute(attribute) => match values.get(attribute) {
                Some(Some(value)) if value.is_finite() => Ok(*value),
                Some(Some(_)) => Err(FormulaError::InvalidSyntax {
                    position: 0,
                    message: format!("attribute `{attribute}` is not a finite number"),
                }),
                Some(None) => Err(FormulaError::MissingValue(attribute.clone())),
                None => Err(FormulaError::UnknownAttribute(attribute.clone())),
            },
            Self::UnaryMinus(expression) => Ok(-expression.evaluate(values)?),
            Self::Binary {
                operator,
                left,
                right,
            } => {
                let left = left.evaluate(values)?;
                let right = right.evaluate(values)?;
                match operator {
                    Operator::Add => Ok(left + right),
                    Operator::Subtract => Ok(left - right),
                    Operator::Multiply => Ok(left * right),
                    Operator::Divide if right == 0.0 => Err(FormulaError::DivisionByZero),
                    Operator::Divide => Ok(left / right),
                }
            }
        }
    }
}

struct Parser<'a> {
    source: &'a str,
    position: usize,
}

impl<'a> Parser<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            source,
            position: 0,
        }
    }

    fn expression(&mut self) -> Result<Expression, FormulaError> {
        let mut left = self.term()?;
        loop {
            self.skip_whitespace();
            let operator = match self.peek_char() {
                Some('+') => Operator::Add,
                Some('-') => Operator::Subtract,
                _ => return Ok(left),
            };
            self.consume_char();
            let right = self.term()?;
            left = Expression::Binary {
                operator,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
    }

    fn term(&mut self) -> Result<Expression, FormulaError> {
        let mut left = self.factor()?;
        loop {
            self.skip_whitespace();
            let operator = match self.peek_char() {
                Some('*') => Operator::Multiply,
                Some('/') => Operator::Divide,
                _ => return Ok(left),
            };
            self.consume_char();
            let right = self.factor()?;
            left = Expression::Binary {
                operator,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
    }

    fn factor(&mut self) -> Result<Expression, FormulaError> {
        self.skip_whitespace();
        if self.consume_if('-') {
            return Ok(Expression::UnaryMinus(Box::new(self.factor()?)));
        }
        if self.consume_if('(') {
            let expression = self.expression()?;
            self.skip_whitespace();
            if !self.consume_if(')') {
                return Err(self.error("expected `)`"));
            }
            return Ok(expression);
        }
        if self
            .peek_char()
            .is_some_and(|character| character.is_ascii_digit() || character == '.')
        {
            return self.number();
        }
        if self.peek_char().is_some_and(is_identifier_start) {
            return Ok(Expression::Attribute(self.identifier()));
        }
        Err(self.error("expected a number, attribute reference, or `(`"))
    }

    fn number(&mut self) -> Result<Expression, FormulaError> {
        let start = self.position;
        let mut decimal_points = 0;
        while let Some(character) = self.peek_char() {
            if character.is_ascii_digit() {
                self.consume_char();
            } else if character == '.' {
                decimal_points += 1;
                self.consume_char();
            } else {
                break;
            }
        }
        let value = self.source[start..self.position]
            .parse::<f64>()
            .map_err(|_| self.error("invalid number"))?;
        if decimal_points > 1 || !value.is_finite() {
            return Err(self.error("invalid number"));
        }
        Ok(Expression::Number(value))
    }

    fn identifier(&mut self) -> String {
        let start = self.position;
        self.consume_char();
        while self.peek_char().is_some_and(is_identifier_continue) {
            self.consume_char();
        }
        self.source[start..self.position].to_owned()
    }

    fn skip_whitespace(&mut self) {
        while self.peek_char().is_some_and(char::is_whitespace) {
            self.consume_char();
        }
    }

    fn consume_if(&mut self, expected: char) -> bool {
        if self.peek_char() == Some(expected) {
            self.consume_char();
            true
        } else {
            false
        }
    }

    fn consume_char(&mut self) -> Option<char> {
        let character = self.peek_char()?;
        self.position += character.len_utf8();
        Some(character)
    }

    fn peek_char(&self) -> Option<char> {
        self.source[self.position..].chars().next()
    }

    fn at_end(&self) -> bool {
        self.position == self.source.len()
    }

    fn error(&self, message: &str) -> FormulaError {
        FormulaError::InvalidSyntax {
            position: self.position,
            message: message.to_owned(),
        }
    }
}

fn is_identifier_start(character: char) -> bool {
    character.is_ascii_alphabetic() || character == '_'
}

fn is_identifier_continue(character: char) -> bool {
    is_identifier_start(character) || character.is_ascii_digit() || character == '-'
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(entries: &[(&str, Option<f64>)]) -> HashMap<String, Option<f64>> {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), *value))
            .collect()
    }

    #[test]
    fn evaluates_precedence_and_parentheses() {
        let formula = Formula::parse("price_net * (1 + vat_rate)").unwrap();
        assert_eq!(
            formula
                .evaluate(&values(&[
                    ("price_net", Some(100.0)),
                    ("vat_rate", Some(0.23))
                ]))
                .unwrap(),
            123.0
        );
    }

    #[test]
    fn extracts_unique_dependencies_in_stable_order() {
        let formula = Formula::parse("price_net * (1 + vat_rate) + price_net").unwrap();
        assert_eq!(formula.dependencies(), ["price_net", "vat_rate"]);
    }

    #[test]
    fn reports_missing_contextual_value() {
        let formula = Formula::parse("price_net + vat_rate").unwrap();
        assert_eq!(
            formula.evaluate(&values(&[("price_net", Some(100.0)), ("vat_rate", None)])),
            Err(FormulaError::MissingValue("vat_rate".into()))
        );
    }

    #[test]
    fn rejects_invalid_syntax_and_division_by_zero() {
        assert!(matches!(
            Formula::parse("price_net * ("),
            Err(FormulaError::InvalidSyntax { .. })
        ));
        let formula = Formula::parse("price_net / vat_rate").unwrap();
        assert_eq!(
            formula.evaluate(&values(&[
                ("price_net", Some(100.0)),
                ("vat_rate", Some(0.0))
            ])),
            Err(FormulaError::DivisionByZero)
        );
    }
}
